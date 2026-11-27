"""Local preview reporter. All observations go through the same authenticated HTTP API as agents."""

import argparse
import json
import time
from pathlib import Path
from random import Random
from urllib.request import urlopen

from agent import MEASUREMENT_INTERVAL
from transport import get_tasks, post, run_periodically, task_result

MIB = 1024**2
LINK_MS = {"gz-hk": 23, "sh-hk": 29, "hk-hk": 3, "hk-jp": 44, "la-sjc": 10}
ROUTE_MS = {"hk-main": 47, "hk-backup": 51, "us-main": 195, "us-direct": 160, "jp-main": 95}
# Documentation addresses and their example GeoIP results, included in client reports.
PEERS = [
    ("192.0.2.18", "浙江 · 杭州", "电信"),
    ("2001:db8:32::54", "江苏 · 南京", "电信"),
    ("203.0.113.71", "四川 · 成都", "移动"),
]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://127.0.0.1:4186")
    p.add_argument("--tokens", type=Path, required=True)
    args = p.parse_args()
    rng = Random()
    counters = {}
    start = int(time.time())
    tick = 0
    next_measurement = 0

    def send():
        nonlocal tick, next_measurement
        tick += 1
        now = time.monotonic()
        with urlopen(args.url + "/api/v1/config", timeout=4) as r:
            cfg = json.load(r)
        at = time.time_ns() // 1_000_000
        measure = now >= next_measurement
        if measure:
            next_measurement = now + MEASUREMENT_INTERVAL

        def emit(key, token, data):
            post(
                args.url,
                token,
                dict(reporter=key, source="simulated", at=at, **data),
            )

        for n in cfg["nodes"]:
            key = n["id"]
            if n["kind"] != "agent" or n["source"] != "simulated":
                continue
            if key == "tpe" and 2 < tick % 36 < 31:
                continue
            scale = sum(map(ord, key)) % 6 + 1
            up, down = round(scale * rng.uniform(5, 10), 2), round(scale * rng.uniform(8, 15), 2)
            tx, rx = counters.get(key, (500 * MIB, 650 * MIB))
            tx += round(up * 5_000_000 / 8)
            rx += round(down * 5_000_000 / 8)
            counters[key] = (tx, rx)
            ram = rng.uniform(38, 64)
            h = dict(
                cpu=round(rng.uniform(12, 59), 2),
                ram=ram,
                ramUsed=8 * ram / 100,
                memoryGiB=8,
                disk=44,
                diskUsed=44,
                diskGiB=100,
                up=up,
                down=down,
                txBytes=tx,
                rxBytes=rx,
                nic="eth0",
                boot=(start - 40 * 86400) * 1000,
                os="Debian 12",
                processor="虚拟处理器",
                arch="x86_64",
                cores=4,
                version="local-reporter/1",
            )
            token = (args.tokens / key).read_text().strip()
            if not measure:
                emit(key, token, {"host": h})
                continue
            plan = get_tasks(args.url, token, key, "simulated")
            links = {}
            for lid, l in plan["links"].items():
                bad = lid == "gz-hk" and tick % 24 < 9
                s = dict(
                    latency=round(
                        max(0.2, LINK_MS.get(lid, 20) * rng.uniform(0.94, 1.09) + (7 if bad else 0)), 1
                    ),
                    forward=round(rng.uniform(6, 19), 1),
                    reverse=round(rng.uniform(15, 34), 1),
                )
                s["packetLoss" if l["mode"] == "ICMP" else "failureRate"] = (
                    round(rng.uniform(1, 3), 1) if bad else 0
                )
                links[lid] = task_result(l, s)
            emit(key, token, dict(host=h, links=links))
        routes = {}
        sessions = {}
        token = (args.tokens / "client").read_text().strip()
        plan = get_tasks(args.url, token, "client", "simulated")
        for i, (rid, r) in enumerate(plan["profiles"].items()):
            task = plan["routes"].get(rid)
            if task and measure:
                routes[rid] = task_result(
                    task,
                    (
                        {"status": "timeout"}
                        if tick % 53 == 17 and i == 0
                        else dict(
                            status="ok", latency=round(ROUTE_MS.get(rid, 60) * rng.uniform(0.94, 1.06), 1)
                        )
                    ),
                )
            peer = PEERS[0 if r["entry"] == "gz" else 1]
            if rid == "hk-backup":
                peer = PEERS[2 if tick // 18 % 2 else 1]
            ip, place, provider = peer
            ping = r["direct"] and any(n["id"] == r["entry"] and n["kind"] == "ping" for n in cfg["nodes"])
            s = sessions.setdefault(
                (ip, r["entry"]),
                dict(
                    ip=ip,
                    place=place,
                    provider=provider,
                    entry=r["entry"],
                    mode="ICMP" if ping else "TCP",
                    latency=round(rng.uniform(5, 12) if not r["direct"] else rng.uniform(147, 160), 1),
                    traffic={},
                ),
            )
            s["packetLoss" if s["mode"] == "ICMP" else "failureRate"] = 0
            s["traffic"][rid] = {
                "forward": round(rng.uniform(3, 8), 1),
                "reverse": round(rng.uniform(8, 17), 1),
            }
        if not plan["profiles"]:
            return
        emit(
            "client",
            token,
            dict(
                sessions=list(sessions.values()),
                routes=routes,
                routeVersions={rid: p["version"] for rid, p in plan["profiles"].items()},
            ),
        )

    run_periodically(send, 5)


if __name__ == "__main__":
    main()
