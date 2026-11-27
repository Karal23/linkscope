"""Run the local panel, a real Linux agent, and the preview reporters together."""

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4186)
    parser.add_argument("--state", type=Path, default=ROOT / ".local-state")
    parser.add_argument("--no-sim", action="store_true", help="只启动后端与本机探针")
    args = parser.parse_args()
    url = f"http://127.0.0.1:{args.port}"
    state = args.state.resolve()
    processes = []

    def start(file, *params):
        p = subprocess.Popen([sys.executable, str(ROOT / file), *map(str, params)])
        processes.append(p)
        return p

    try:
        server = start(
            "backend/server.py",
            "--state",
            state,
            "--port",
            args.port,
            "--initial-config",
            ROOT / "examples/topology.json",
        )
        for _ in range(60):
            if server.poll() is not None:
                return server.returncode or 1
            try:
                with urlopen(url + "/api/v1/config", timeout=0.5) as resp:
                    cfg = json.load(resp)
                break
            except URLError:
                time.sleep(0.1)
        else:
            raise SystemExit("后端启动超时")
        if any(n["id"] == "local" and n["kind"] == "agent" and n["source"] == "system" for n in cfg["nodes"]):
            start(
                "probes/agent.py", "--id", "local", "--url", url, "--token-file", state / "tokens" / "local"
            )
        if not args.no_sim:
            start("probes/simulate.py", "--url", url, "--tokens", state / "tokens")
        print(f"拓扑 http://localhost:{args.port}/    管理 http://localhost:{args.port}/admin", flush=True)
        return server.wait()
    except KeyboardInterrupt:
        return 0
    finally:
        for p in reversed(processes):
            if p.poll() is None:
                p.terminate()
        for p in processes:
            p.wait()


if __name__ == "__main__":
    sys.exit(main())
