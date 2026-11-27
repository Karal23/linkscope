import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "probes"))
import agent
import transport


class ControlTransport(unittest.TestCase):
    def test_reuses_socket_replays_same_report_after_disconnect_and_refuses_redirect(self):
        requests = []
        posts = []

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                requests.append((self.client_address, self.path))
                redirect = self.path == "/redirect"
                self.send_response(302 if redirect else 200)
                if redirect:
                    self.send_header("Location", "/redirect-target")
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def do_POST(self):
                posts.append((self.client_address, self.rfile.read(int(self.headers["Content-Length"]))))
                if len(posts) == 1:
                    self.close_connection = True
                    return
                self.do_GET()

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}"
                with patch.object(transport, "getproxies", return_value={}):
                    for _ in range(2):
                        self.assertEqual(transport.get_tasks(url, "test", "node"), {})
                    report = {"reporter": "node", "at": 123}
                    self.assertEqual(transport.post(url, "test", report), {})
                    with self.assertRaises(HTTPError) as rejected:
                        transport.read_control(Request(url + "/redirect"))
                    self.assertEqual(rejected.exception.code, 302)
                self.assertEqual(requests[0][0], requests[1][0])
                self.assertEqual(posts[0][0], requests[0][0])
                self.assertNotEqual(posts[0][0], posts[1][0])
                self.assertEqual(posts[0][1], posts[1][1])
                self.assertEqual(json.loads(posts[1][1]), report)
                self.assertNotIn("/redirect-target", [p for _, p in requests])
            finally:
                server.shutdown()
                thread.join()


class ProbeSchedule(unittest.TestCase):
    def test_latency_runs_every_thirty_seconds_and_rewired_tasks_start_at_next_poll(self):
        now = 0
        reports = {group: [] for group in ("host", "links", "routes", "references")}

        def sleep(seconds):
            nonlocal now
            now += seconds

        def plan(*args):
            if now >= 65:
                raise StopIteration
            return {
                "links": {"edge": {"version": 1 if now < 10 else 2}},
                "routes": {"chain": {"version": 1}},
                "references": {"zj-cu": {}},
            }

        def post(url, token, body, *, want_tasks, known):
            for group in reports.keys() & body.keys():
                reports[group].append(now)
            if want_tasks:
                current = plan()
                tag = str(current["links"]["edge"]["version"])
                self.assertEqual(known, None if now == 0 else "1" if now <= 10 else "2")
                return {"tasks": {"unchanged": True} if known == tag else {**current, "planTag": tag}}

        with (
            patch.object(agent.time, "monotonic", side_effect=lambda: now),
            patch.object(agent.time, "sleep", side_effect=sleep),
            patch.object(agent, "get_tasks", side_effect=AssertionError("heartbeat already includes the plan")),
            patch.object(agent, "measure_assignment", return_value={"latency": 1}),
            patch.object(agent, "measure_reference", return_value={"latency": 2}),
            patch.object(agent, "post", side_effect=post),
            self.assertRaises(StopIteration),
        ):
            agent.collect("http://localhost", "node", "test", Mock(), {}, once=False)
        self.assertEqual(reports["host"], list(range(0, 66, 5)))
        self.assertEqual(reports["links"], [0, 10, 40])
        self.assertEqual(reports["routes"], [0, 30, 60])
        self.assertEqual(reports["references"], [0, 30, 60])

    def test_tcp_probe_distinguishes_timeout_from_a_refusal_and_local_errors(self):
        probe = {"mode": "TCP", "host": "127.0.0.1", "port": 80}
        with patch.object(agent.socket, "create_connection") as dial:
            success = agent.measure_link(probe)
            self.assertEqual((success["failureRate"], success["tcpTimeout"]), (0, 0))
            for error, expected in ((TimeoutError(), 100), (ConnectionRefusedError(), 0), (OSError(), None)):
                dial.side_effect = error
                sample = agent.measure_link(probe)
                self.assertEqual(
                    (sample["latency"], sample["failureRate"], sample.get("tcpTimeout")),
                    (None, 100, expected),
                )

    def test_probe_reports_only_assigned_reference_points_and_no_peer_addresses(self):
        points = {
            k: {"mode": "ICMP", "host": k + ".example", "provider": provider, "region": "浙江"}
            for k, provider in (("zj-ct", "电信"), ("zj-cu", "联通"))
        }
        reports = []
        with (
            patch.object(agent, "get_tasks", return_value={"links": {}, "routes": {}, "references": points}),
            patch.object(agent, "measure_link", return_value={"latency": 8, "packetLoss": 0}),
            patch.object(agent, "post", side_effect=lambda url, token, body, **kw: reports.append(body)),
        ):
            agent.collect("http://127.0.0.1", "node", "test", Mock(), {}, once=True)
        self.assertEqual({k for report in reports for k in report.get("references", {})}, set(points))
        self.assertEqual(sum("references" in report for report in reports), 1)
        self.assertTrue(all("ingress" not in report for report in reports))

    def test_tls_route_waits_for_target_handshake_without_an_http_request(self):
        task = {"proxy": "http://127.0.0.1:3030", "url": "https://test.example:8443/", "testMode": "tls"}
        with patch.object(agent.http.client, "HTTPSConnection") as factory:
            connection = factory.return_value
            self.assertEqual(agent.test_route(task)["status"], "ok")
            connection.set_tunnel.assert_called_once_with("test.example", 8443)
            connection.connect.assert_called_once()
            connection.request.assert_not_called()
            connection.connect.side_effect = TimeoutError()
            self.assertEqual(agent.test_route(task), {"status": "timeout"})
        with self.assertRaises(ValueError):
            agent.test_route(dict(task, url="http://test.example/"))

    def test_rejected_batch_still_delivers_other_measurements(self):
        packets = []
        plan = {"links": {k: {"version": 1} for k in ("removed", "kept")}, "routes": {}}

        def post(url, token, packet, **kw):
            packets.append(set(packet["links"]))
            if "removed" in packet["links"]:
                raise HTTPError(url, 409, "已撤销", {}, None)

        with (
            patch.object(agent, "get_tasks", return_value=plan),
            patch.object(agent, "measure_assignment", return_value={"latency": 5}),
            patch.object(agent, "post", side_effect=post),
            self.assertRaises(HTTPError),
        ):
            agent.collect("http://localhost", "client", "test", None, {}, once=True)
        self.assertEqual(packets, [{"kept", "removed"}, {"removed"}, {"kept"}])

    def test_heartbeat_and_completed_result_arrive_before_a_slow_check(self):
        slow_started = threading.Event()
        fast_reported = threading.Event()
        reports = []
        plan = {"links": {key: {"version": 1, "target": key} for key in ("slow", "fast")}, "routes": {}}

        def measure(group, task, local):
            if task["target"] == "slow":
                slow_started.set()
                self.assertTrue(fast_reported.wait(3))
            else:
                self.assertTrue(slow_started.wait(3))
            return {"latency": 10}

        def post(url, token, packet, **kw):
            reports.append(packet)
            if "fast" in packet.get("links", {}):
                fast_reported.set()

        with (
            patch.object(agent, "get_tasks", return_value=plan),
            patch.object(agent, "measure_assignment", side_effect=measure),
            patch.object(agent, "post", side_effect=post),
        ):
            agent.collect("http://127.0.0.1", "node", "test", Mock(), {}, once=True)
        self.assertIn("host", reports[0])
        self.assertEqual([list(p["links"]) for p in reports[1:]], [["fast"], ["slow"]])
        stamps = [p["at"] for p in reports]
        self.assertEqual(stamps, sorted(set(stamps)))
