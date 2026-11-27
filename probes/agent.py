"""Linux host collector. Optional checks run on the probe, against its configured endpoints."""

import argparse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import http.client
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit

from transport import control_url, get_tasks, post, task_result, tls_context

GIB = 1024**3
MEASUREMENT_INTERVAL = 30
REPORT_BATCH_WINDOW = 0.2


class LinuxHost:
    def __init__(self, nic):
        routes = Path("/proc/net/route").read_text().splitlines()[1:]
        default = next((line.split()[0] for line in routes if line.split()[1] == "00000000"), None)
        self.nic = (
            nic or default or next((p.name for p in Path("/sys/class/net").iterdir() if p.name != "lo"), "lo")
        )
        self.prior = self.counters()
        stat = Path("/proc/stat").read_text().splitlines()
        cpuinfo = Path("/proc/cpuinfo").read_text().splitlines()
        self.fixed = dict(
            os=platform.freedesktop_os_release().get("PRETTY_NAME", "Linux"),
            arch=platform.machine(),
            processor=next(
                (s.partition(":")[2].strip() for s in cpuinfo if s.startswith("model name")),
                platform.machine(),
            ),
            cores=os.cpu_count(),
            nic=self.nic,
            boot=int(next(s for s in stat if s.startswith("btime ")).split()[1]) * 1000,
            version="linkscope/2",
        )

    def counters(self):
        cpu = list(map(int, Path("/proc/stat").read_text().splitlines()[0].split()[1:9]))
        stats = Path("/sys/class/net") / self.nic / "statistics"
        return (
            time.monotonic(),
            sum(cpu),
            cpu[3] + cpu[4],
            int((stats / "tx_bytes").read_text()),
            int((stats / "rx_bytes").read_text()),
        )

    def read(self):
        sample = self.counters()
        t, total, idle, tx, rx = sample
        last, old_total, old_idle, old_tx, old_rx = self.prior
        self.prior = sample
        memory = {
            s.partition(":")[0]: int(s.split()[1]) * 1024
            for s in Path("/proc/meminfo").read_text().splitlines()
            if ":" in s
        }
        ram = memory["MemTotal"] - memory["MemAvailable"]
        disk = shutil.disk_usage("/")
        delta = total - old_total
        rate = lambda a, b: (
            round((a - b) * 8 / (t - last) / 1_000_000, 5) if t - last >= 0.1 and a >= b else None
        )
        return dict(
            **self.fixed,
            cpu=round(max(0, min(100, 100 * (1 - (idle - old_idle) / delta))), 2) if delta > 0 else None,
            ram=100 * ram / memory["MemTotal"],
            ramUsed=ram / GIB,
            memoryGiB=round(memory["MemTotal"] / GIB, 2),
            disk=100 * disk.used / disk.total,
            diskUsed=disk.used / GIB,
            diskGiB=round(disk.total / GIB, 2),
            up=rate(tx, old_tx),
            down=rate(rx, old_rx),
            txBytes=tx,
            rxBytes=rx,
        )


def measure_link(check):
    host = check["host"]
    method = check["mode"]
    if method == "TCP":
        start = time.monotonic()
        try:
            with socket.create_connection((host, check["port"]), timeout=2):
                return {
                    "latency": round((time.monotonic() - start) * 1000, 2),
                    "failureRate": 0,
                    "tcpTimeout": 0,
                }
        except TimeoutError:
            return {"latency": None, "failureRate": 100, "tcpTimeout": 100}
        except ConnectionRefusedError:
            return {"latency": None, "failureRate": 100, "tcpTimeout": 0}
        except OSError:
            return {"latency": None, "failureRate": 100}
    if method != "ICMP":
        raise ValueError("分段测量方式需为 TCP 或 ICMP")
    result = subprocess.run(
        ["ping", "-n", "-c", "3", "-i", "0.2", "-W", "1", "--", host],
        capture_output=True,
        text=True,
        timeout=5,
        env={**os.environ, "LC_ALL": "C"},
    )
    loss = re.search(r"([\d.]+)% packet loss", result.stdout)
    rtt = re.search(r"= [\d.]+/([\d.]+)/", result.stdout)
    return dict(latency=float(rtt[1]) if rtt else None, packetLoss=float(loss[1]) if loss else None)


def test_route(check):
    target = urlsplit(check["url"])
    proxy = urlsplit(check["proxy"])
    if (
        proxy.scheme != "http"
        or not proxy.hostname
        or target.scheme not in ("http", "https")
        or not target.hostname
        or (check.get("testMode") == "tls" and target.scheme != "https")
    ):
        raise ValueError("线路测试需填写 HTTP 代理和 HTTP(S) 测试地址")
    if target.scheme == "https":
        connection = http.client.HTTPSConnection(
            proxy.hostname, proxy.port or 80, timeout=3, context=tls_context()
        )
        connection.set_tunnel(target.hostname, target.port or 443)
        path = target.path or "/"
        if target.query:
            path += "?" + target.query
    else:
        connection = http.client.HTTPConnection(proxy.hostname, proxy.port or 80, timeout=3)
        path = check["url"]
    start = time.monotonic()
    try:
        if check.get("testMode") == "tls":
            # HTTP proxy CONNECT may acknowledge locally. TLS proves the far end answered.
            connection.connect()
            return dict(status="ok", latency=round((time.monotonic() - start) * 1000, 2))
        connection.request("GET", path, headers={"Host": target.netloc, "Connection": "close"})
        with connection.getresponse() as response:
            if response.status == 204:
                return dict(status="ok", latency=round((time.monotonic() - start) * 1000, 2))
            return {"status": "failed"}
    except TimeoutError:
        return {"status": "timeout"}
    except (OSError, http.client.HTTPException):
        return {"status": "failed"}
    finally:
        connection.close()


def measure_assignment(group, task, local):
    definition = task.copy()
    fields = (
        (("host", "port") if task["mode"] == "TCP" else ("host",)) if group == "links" else ("proxy", "url")
    )
    if local and (local.get("version") == task["version"] or task["allowLocalChecks"]):
        if group == "routes" or local.get("mode") == task["mode"]:
            for field in fields:
                if not definition.get(field):
                    definition[field] = local.get(field)
    if not all(definition.get(field) for field in fields):
        return None
    try:
        reading = measure_link(definition) if group == "links" else test_route(definition)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return task_result(task, reading)


def measure_reference(target):
    mode = target.get("mode", "TCP")
    try:
        reading = measure_link({**target, "mode": mode})
    except (OSError, subprocess.TimeoutExpired):
        reading = {"latency": None}
    return {
        "region": target["region"],
        "provider": target["provider"],
        "mode": mode,
        **reading,
    }


def collect(url, reporter, token, host, checks, once):
    last_stamp = 0
    plan = {}

    def send(parts, want_tasks=False):
        nonlocal last_stamp
        # Only the scheduler publishes. Simultaneous completions must not share a receipt timestamp.
        last_stamp = max(time.time_ns() // 1_000_000, last_stamp + 1)
        report = {"reporter": reporter, "source": "system", "at": last_stamp, **parts}
        return post(url, token, report, want_tasks=want_tasks, known=plan.get("planTag") if want_tasks else None)

    def attempt(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except (OSError, ValueError) as err:
            if once:
                raise
            print(f"探针请求未完成 {err}", file=sys.stderr, flush=True)

    def send_results(parts):
        try:
            send(parts)
        except HTTPError as err:
            if err.code not in (400, 403, 409, 413) or sum(map(len, parts.values())) == 1:
                raise
            # An assignment may have changed while a different result in this batch is still valid.
            failure = None
            for group, results in parts.items():
                for key, result in results.items():
                    try:
                        send({group: {key: result}})
                    except (OSError, ValueError) as single_error:
                        failure = single_error
            if failure is not None:
                raise failure

    pending = {}
    next_poll = 0
    next_measurement = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        while True:
            poll_time = time.monotonic()
            if poll_time >= next_poll:
                next_poll = poll_time + 5
                receipt = attempt(send, {"host": host.read()}, True) if host else None
                update = receipt.get("tasks") if receipt else None
                if update is None:
                    update = attempt(get_tasks, url, token, reporter, known=plan.get("planTag"))
                if update is not None:
                    if not update.get("unchanged"):
                        plan = update
                    wanted = {
                        (group, key, task["version"]): task
                        for group in ("links", "routes")
                        for key, task in plan[group].items()
                    }
                    wanted.update(
                        {("references", key, 0): target for key, target in plan.get("references", {}).items()}
                    )
                    for identity in next_measurement.keys() - wanted.keys():
                        del next_measurement[identity]
                        if identity in pending and pending[identity].cancel():
                            del pending[identity]
                    for identity, task in wanted.items():
                        if identity in pending or poll_time < next_measurement.get(identity, 0):
                            continue
                        next_measurement[identity] = poll_time + MEASUREMENT_INTERVAL
                        group, key, _ = identity
                        if group == "references":
                            pending[identity] = pool.submit(measure_reference, task)
                        else:
                            local = checks.get(group, {}).get(key, {})
                            pending[identity] = pool.submit(measure_assignment, group, task, local)
            remaining = max(0, next_poll - time.monotonic())
            if pending:
                done, _ = wait(
                    pending.values(), timeout=None if once else remaining, return_when=FIRST_COMPLETED
                )
                if done and len(done) < len(pending):
                    budget = REPORT_BATCH_WINDOW
                    if not once:
                        budget = min(budget, max(0, next_poll - time.monotonic()))
                    done, _ = wait(pending.values(), timeout=budget)
                parts = {}
                for identity in [i for i, future in pending.items() if future in done]:
                    result = pending.pop(identity).result()
                    if result:
                        group, key, _ = identity
                        if key in parts.get(group, {}):
                            # Two versions of the same task need separate timestamped reports.
                            attempt(send_results, parts)
                            parts = {}
                        parts.setdefault(group, {})[key] = result
                if parts:
                    attempt(send_results, parts)
            if once:
                if not pending:
                    return
                # A one-shot run drains exactly the assignments from its first poll.
                next_poll = float("inf")
            elif not pending:
                time.sleep(max(0, next_poll - time.monotonic()))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://127.0.0.1:4186")
    p.add_argument("--id", required=True)
    p.add_argument("--token-file", type=Path, required=True)
    p.add_argument("--nic")
    p.add_argument("--checks", type=Path)
    p.add_argument("--once", action="store_true")
    args = p.parse_args()
    token = args.token_file.read_text().strip()
    checks = json.loads(args.checks.read_text()) if args.checks else {}
    host = LinuxHost(args.nic) if args.id != "client" else None
    if host:
        time.sleep(0.2)

    collect(control_url(args.url), args.id, token, host, checks, args.once)


if __name__ == "__main__":
    main()
