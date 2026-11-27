import io
import json
import os
import secrets
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "probes"))
import accounts
from credentials import manage
from dashboard import latency_bars, record_summaries, snapshot
from server import Application, HistoryCache, public_authority
from store import DAY, config, connect, init, now_ms, save_config, write_sample
from transport import control_url

ORIGIN = "https://panel.example.test"


class PublicPanel(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name)
        seed = self.state / "seed.json"
        seed.write_text(
            json.dumps(
                {
                    "nodes": [{"id": "edge", "name": "入口", "kind": "agent", "address": "192.0.2.82"}],
                    "links": [],
                    "routes": [
                        {
                            "id": "direct",
                            "name": "直连",
                            "entry": "edge",
                            "tail": [],
                            "test": True,
                            "testProxy": "http://private.example.test:3311",
                            "testUrl": "https://check.example.test/204",
                        },
                        {"id": "extra", "name": "备用", "entry": "edge", "tail": []},
                    ],
                }
            )
        )
        init(self.state, seed)
        self.password = secrets.token_urlsafe(24)
        self.db = connect(self.state)
        self.addCleanup(self.db.close)
        with self.db:
            for role in accounts.ROLES:
                accounts.set_password(self.db, role, self.password)
        self.app = Application(self.state, {public_authority(ORIGIN)}, ORIGIN)

    def request(self, path, method="GET", data=None, cookie="", identity=None, origin=ORIGIN):
        path, _, query = path.partition("?")
        raw = json.dumps(data).encode() if data is not None else b""
        env = {
            "PATH_INFO": path,
            "QUERY_STRING": query,
            "REQUEST_METHOD": method,
            "HTTP_HOST": "panel.example.test",
            "HTTP_COOKIE": cookie,
            "HTTP_ORIGIN": origin,
            "HTTP_X_LINKSCOPE_ADMIN": "1",
            "CONTENT_TYPE": "application/json",
            "CONTENT_LENGTH": str(len(raw)),
            "wsgi.input": io.BytesIO(raw),
        }
        if identity:
            env["HTTP_AUTHORIZATION"] = "Bearer " + (self.state / "tokens" / identity).read_text()
        result = {}

        def start(status, headers):
            result.update(status=int(status.split()[0]), headers=dict(headers))

        out = b"".join(self.app(env, start))
        return result["status"], result["headers"], out

    def login(self, role):
        code, headers, _ = self.request("/api/v1/login", "POST", {"role": role, "password": self.password})
        self.assertEqual(code, 200)
        cookie = headers["Set-Cookie"]
        for attr in ("Secure", "HttpOnly", "SameSite=Strict", "Path=/"):
            self.assertIn(attr, cookie)
        return cookie.split(";", 1)[0]

    @patch.dict(os.environ, {"LINKSCOPE_FIXED_INGRESS": "zhejiang"})
    def test_heartbeat_can_return_only_the_authenticated_hosts_current_tasks(self):
        heartbeat = {"reporter": "edge", "at": now_ms(), "host": {}}
        expected = json.loads(self.request("/api/v1/tasks?reporter=edge", identity="edge")[2])
        self.assertEqual(set(expected["references"]), {"zj-ct", "zj-cu"})
        path = "/api/v1/reports?tasks=1"
        self.assertEqual(self.request(path, "POST", heartbeat, identity="client")[0], 403)
        for _ in range(2):
            code, _, body = self.request(path, "POST", heartbeat, identity="edge")
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body), {"accepted": True, "tasks": expected})
        plain = self.request("/api/v1/reports", "POST", heartbeat, identity="edge")
        self.assertEqual(json.loads(plain[2]), {"accepted": True})
        known = "&known=" + expected["planTag"]
        confirmed = self.request(path + known, "POST", heartbeat, identity="edge")
        self.assertEqual(json.loads(confirmed[2]), {"accepted": True, "tasks": {"unchanged": True}})
        poll = "/api/v1/tasks?reporter=edge" + known
        self.assertEqual(json.loads(self.request(poll, identity="edge")[2]), {"unchanged": True})
        self.assertEqual(self.request(poll, identity="client")[0], 403)
        with patch.dict(os.environ, {"LINKSCOPE_FIXED_INGRESS": ""}):
            changed = json.loads(self.request(poll, identity="edge")[2])
            self.assertEqual(changed["references"], {})
            self.assertNotEqual(changed["planTag"], expected["planTag"])

    def test_scoped_and_paused_trends_keep_the_same_history(self):
        with self.db:
            record_summaries(self.db, {})
        self.assertFalse(self.db.execute("SELECT 1 FROM latest WHERE kind='summary'").fetchone())
        full = json.loads(self.request("/api/v1/state")[2])
        self.assertEqual(set(full["trends"]), {"all", "direct", "extra"})
        for scope, expected in (("all", "all"), ("direct", "direct"), ("removed", "all")):
            frame = json.loads(self.request("/api/v1/state?trend=" + scope)[2])
            self.assertEqual(list(frame["trends"]), [expected])
            key = frame["summaries"][expected].get("version")
            query = {"kind": "summary", "id": expected, "end": frame["now"], "minutes": 60, "resolution": "trend"}
            if key is not None:
                query["version"] = key
            paused = json.loads(self.request("/api/v1/history?" + urlencode(query))[2])
            self.assertEqual(paused, frame["trends"][expected])
            self.assertEqual(len(paused), 22)
            self.assertTrue(any(p["v"] for p in paused))

    def test_login_roles_logout_reset_and_csrf(self):
        self.assertEqual(self.request("/")[0], 200)
        self.assertEqual(self.request("/admin")[1]["Location"], "/login?next=admin")
        self.assertEqual(self.request("/api/v1/config")[0], 401)
        for path in ("state", "history?kind=host&id=edge", "versions?kind=route&id=direct"):
            self.assertEqual(self.request("/api/v1/" + path)[0], 200)
        viewer = self.login("viewer")
        admin = self.login("admin")
        self.assertEqual(self.request("/admin.html", cookie=viewer)[0], 403)
        self.assertEqual(self.request("/api/v1/config", cookie=viewer)[0], 403)
        self.assertEqual(self.request("/api/v1/config", "PUT", {}, cookie=viewer)[0], 403)
        self.assertEqual(self.request("/api/v1/tasks?reporter=edge", cookie=admin)[0], 401)
        self.assertEqual(self.request("/api/v1/config", identity="edge")[0], 401)
        code, _, raw = self.request("/api/v1/config", cookie=admin)
        self.assertEqual(code, 200)
        cfg = json.loads(raw)
        cfg["nodes"][0]["name"] = "已修改"
        cfg["nodes"][0]["countryCode"] = "jp"
        self.assertEqual(
            self.request("/api/v1/config", "PUT", cfg, cookie=admin, origin="https://other.example.test")[0],
            403,
        )
        code, _, saved = self.request("/api/v1/config", "PUT", cfg, cookie=admin)
        self.assertEqual(code, 200)
        result = json.loads(saved)
        self.assertEqual(result["revision"], cfg["revision"] + 1)
        self.assertEqual(result["nodes"][0]["countryCode"], "JP")
        self.assertEqual(result, json.loads(self.request("/api/v1/config", cookie=admin)[2]))
        self.assertEqual(self.request("/api/v1/logout", "POST", cookie=viewer)[0], 200)
        self.assertFalse(json.loads(self.request("/api/v1/state", cookie=viewer)[2])["signedIn"])
        viewer = self.login("viewer")
        with self.db:
            accounts.set_password(self.db, "viewer", secrets.token_urlsafe(18))
        self.assertFalse(json.loads(self.request("/api/v1/state", cookie=viewer)[2])["signedIn"])
        self.assertEqual(self.request("/api/v1/state", cookie=admin)[0], 200)
        with self.db:
            self.db.execute("UPDATE web_sessions SET expires=0")
        self.assertEqual(self.request("/api/v1/config", cookie=admin)[0], 401)
        self.assertEqual(json.loads(self.request("/api/v1/state", cookie=admin)[2])["accessRole"], "viewer")
        with self.assertRaises(ValueError):
            Application(self.state, {"localhost:4186"})

    @patch.dict(os.environ, {"LINKSCOPE_FIXED_INGRESS": "zhejiang"})
    def test_fixed_entries_exist_before_reports_and_ignore_dynamic_sources(self):
        addr = "8.8.4.4"
        points = {"peer-fixed-zj-ct": "浙江电信", "peer-fixed-zj-cu": "浙江联通"}

        def fixed(frame):
            return {n["id"]: n["name"] for n in frame["nodes"] if n.get("kind") == "reference"}

        frame = json.loads(self.request("/api/v1/state")[2])
        self.assertEqual(fixed(frame), points)
        self.assertEqual(len(frame["links"]), 2)
        self.assertTrue(all(l["pending"] for l in frame["links"]))
        self.assertTrue(all(len(r["paths"]) == 2 for r in frame["routes"]))
        at = now_ms() - 100
        old = {"reporter": "edge", "at": at, "host": {}, "ingress": [{"ip": addr, "hop": ""}]}
        self.assertEqual(self.request("/api/v1/reports", "POST", old, identity="edge")[0], 200)
        self.assertEqual(self.request("/api/v1/reports", "POST", old)[0], 401)
        self.assertIsNone(self.db.execute("SELECT body FROM latest WHERE kind='ingress'").fetchone())
        plan = json.loads(self.request("/api/v1/tasks?reporter=client", identity="client")[2])
        self.assertFalse(plan.get("references"))
        session = {
            "reporter": "client",
            "at": at,
            "routeVersions": {k: v["version"] for k, v in plan["profiles"].items()},
            "sessions": [{"ip": addr, "entry": "edge", "traffic": {"direct": {"forward": 4, "reverse": 2}}}],
        }
        self.assertEqual(self.request("/api/v1/reports", "POST", session, identity="client")[0], 200)
        code, _, raw = self.request("/api/v1/state")
        self.assertEqual(code, 200)
        for secret in (addr, "192.0.2.82", "private.example.test", "check.example.test"):
            self.assertNotIn(secret, raw.decode())
        frame = json.loads(raw)
        self.assertEqual(fixed(frame), points)
        self.assertEqual(len(frame["nodes"]), 3)
        self.assertEqual(frame["summaries"]["direct"]["upload"], 4)
        allowed = json.loads(self.request("/api/v1/tasks?reporter=edge", identity="edge")[2])["references"]
        self.assertEqual(set(allowed), {"zj-ct", "zj-cu"})
        self.assertTrue(all(t["mode"] == "ICMP" for t in allowed.values()))

    @patch.dict(os.environ, {"LINKSCOPE_FIXED_INGRESS": "zhejiang"})
    def test_fixed_reference_preserves_existing_history_and_keeps_carriers_separate(self):
        at = now_ms() - 300
        old = {"region": "浙江", "provider": "移动", "mode": "ICMP", "latency": 200, "packetLoss": 0}
        with self.db:
            write_sample(self.db, "reference", "edge/zj-cm-icmp", at - 1, old)
        values = {
            k: {"region": "浙江", "provider": carrier, "mode": "ICMP", "packetLoss": loss, "latency": latency}
            for k, carrier, loss, latency in (("zj-ct", "电信", 0, 8), ("zj-cu", "联通", 33.33, 12))
        }
        packet = {"reporter": "edge", "at": at, "host": {"up": 0.17, "down": 0.31}, "references": values}
        self.assertEqual(self.request("/api/v1/reports", "POST", packet, identity="edge")[0], 200)
        self.assertEqual(
            self.request("/api/v1/reports", "POST", {**packet, "reporter": "client"}, identity="client")[0],
            403,
        )
        self.assertEqual(
            self.request(
                "/api/v1/reports",
                "POST",
                {**packet, "at": at + 1, "references": {"zj-cm": old}},
                identity="edge",
            )[0],
            409,
        )
        frame = json.loads(self.request("/api/v1/state")[2])
        self.assertEqual(frame["summaries"]["all"]["download"], 0.31)
        self.assertEqual(frame["summaries"]["all"]["faults"], 0)
        self.assertEqual(
            frame["summaries"]["direct"]["estimates"], {"edge/zj-ct-icmp": 8, "edge/zj-cu-icmp": 12}
        )
        self.assertEqual(
            {l["referenceId"]: l["reading"]["loss"] for l in frame["links"]},
            {"edge/zj-ct-icmp": 0, "edge/zj-cu-icmp": 33.33},
        )
        url = "/api/v1/history?kind=reference&id=edge%2Fzj-cu-icmp&resolution=samples"
        self.assertEqual([p["v"]["latency"] for p in json.loads(self.request(url)[2]) if p.get("at")], [12])
        self.assertEqual([p["v"] for p in json.loads(self.request(url + "&metric=loss")[2]) if p.get("at")], [{"loss": 33.33}])
        self.assertEqual(self.request(url + "&metric=tcpLoss")[0], 400)
        with self.db:
            record_summaries(self.db, {})
        bars = json.loads(self.request(url.replace("samples", "bars"))[2])
        self.assertEqual([(p["p50"], p["loss"], p["status"]) for p in bars["points"] if p["n"]], [(12, 33.33, "mint")])
        route = "/api/v1/history?kind=summary&id=direct&resolution=bars&carrier="
        estimates = json.loads(self.request(route + "edge%2Fzj-ct-icmp")[2])
        self.assertEqual({(p["p50"], p["status"]) for p in estimates["points"] if p["n"]}, {(8, "mint")})
        estimates = json.loads(self.request(route + "edge%2Fzj-cu-icmp")[2])
        self.assertEqual({(p["p50"], p["status"]) for p in estimates["points"] if p["n"]}, {(12, "mint")})
        host = "/api/v1/history?kind=host&id=edge&minutes=1440&resolution=averages"
        self.assertEqual(json.loads(self.request(host)[2])["points"][-1]["v"]["up"], 0.17)
        self.assertEqual(self.request(host.replace("kind=host", "kind=link"))[0], 400)
        for bad in (
            route + "a%22b",
            "/api/v1/history?kind=summary&id=all&resolution=bars",
            url.replace("samples", "bars") + "&carrier=edge%2Fzj-ct-icmp",
        ):
            self.assertEqual(self.request(bad)[0], 400)
        stale = snapshot(self.db, at + 90_000)
        self.assertEqual(
            {l["referenceId"] for l in frame["links"]}, {l["referenceId"] for l in stale["links"]}
        )
        self.assertTrue(all(not l["measured"] for l in stale["links"]))
        self.assertTrue(all(v is None for v in stale["summaries"]["direct"]["estimates"].values()))

    def test_independent_collectors_redacted_history_and_retention(self):
        viewer, admin = self.login("viewer"), self.login("admin")
        ip = "2001:db8::12"
        at = now_ms() - 10
        for i, name in enumerate(("home", "mobile")):
            with self.db:
                manage(self.db, self.state, "allow-access", name, ["direct"])
            identity = "access." + name
            code, _, body = self.request("/api/v1/tasks?reporter=" + identity, identity=identity)
            plan = json.loads(body)
            self.assertEqual(
                (code, list(plan["profiles"]), plan["links"], plan["routes"]), (200, ["direct"], {}, {})
            )
            v = plan["profiles"]["direct"]["version"]
            packet = {
                "at": at + i,
                "reporter": identity,
                "routeVersions": {"direct": v},
                "sessions": [
                    {
                        "ip": ip,
                        "entry": "edge",
                        "mode": "TCP",
                        "latency": 7 + i,
                        "tcpTimeout": 0,
                        "traffic": {"direct": {"forward": 2, "reverse": 4}},
                    }
                ],
            }
            self.assertEqual(self.request("/api/v1/reports", "POST", packet, identity=identity)[0], 200)
            self.assertEqual(
                self.request("/api/v1/reports", "POST", {**packet, "host": {"cpu": 1}}, identity=identity)[0],
                403,
            )
        code, _, raw = self.request("/api/v1/state", cookie=viewer)
        self.assertEqual(code, 200)
        for field in (ip, "192.0.2.82", "private.example.test", "check.example.test", "testProxy", "testUrl"):
            self.assertNotIn(field, raw.decode())
        peers = [l for l in json.loads(raw)["links"] if l.get("sourceIp")]
        self.assertEqual(len({l["id"] for l in peers}), 2)
        self.assertEqual(json.loads(raw)["summaries"]["direct"]["upload"], 4)
        self.assertIn(ip, self.request("/api/v1/state", cookie=admin)[2].decode())
        for l in peers:
            code, _, points = self.request(
                "/api/v1/history?" + urlencode({"kind": "peer", "id": l["id"]}), cookie=viewer
            )
            self.assertEqual(code, 200)
            self.assertEqual(
                [p["v"]["latency"] for p in json.loads(points) if p["v"]], [l["reading"]["latency"]]
            )
            query = urlencode({"kind": "peer", "id": l["id"], "metric": "tcpLoss"})
            values = json.loads(self.request("/api/v1/history?" + query, cookie=viewer)[2])
            self.assertEqual(l["reading"]["tcpLoss"], 0)
            self.assertEqual([p["v"] for p in values if p["v"]], [{"tcpLoss": 0}])
        self.assertEqual(
            self.request("/api/v1/history?kind=peer&id=peer-access.home-" + ip + "-edge", cookie=viewer)[0],
            404,
        )
        with self.db:
            manage(self.db, self.state, "revoke-access", "mobile")
        self.assertEqual(
            json.loads(self.request("/api/v1/state", cookie=viewer)[2])["summaries"]["direct"]["upload"], 2
        )
        with patch("dashboard.now_ms", return_value=at + DAY + 1000), self.db:
            record_summaries(self.db, {})
        for table in ("samples", "latest"):
            self.assertEqual(
                self.db.execute(f"SELECT count(*) FROM {table} WHERE kind IN ('access','peer')").fetchone()[
                    0
                ],
                0,
            )

    def test_production_credential_boundaries(self):
        self.assertEqual(self.request("/api/v1/tasks?reporter=edge", identity="client")[0], 403)
        self.assertEqual(
            self.request("/api/v1/tasks?reporter=client&source=simulated", identity="client")[0], 403
        )
        self.assertEqual(
            self.request(
                "/api/v1/reports", "POST", {"reporter": "client", "source": "simulated"}, identity="client"
            )[0],
            403,
        )
        self.assertEqual(control_url("http://[::1]:4186/"), "http://[::1]:4186")
        with self.assertRaises(ValueError):
            control_url("http://monitor.example.test")
        with self.assertRaises(ValueError):
            public_authority("http://panel.example.test")
        self.assertEqual(public_authority("https://PANEL.example.test:443/"), "panel.example.test")
        with tempfile.TemporaryDirectory() as t:
            empty = Path(t)
            init(empty, None)
            with self.assertRaises(ValueError):
                Application(empty, {"panel.example.test"}, ORIGIN)

    def test_retired_routes_and_node_source_changes_invalidate_grants(self):
        with self.db:
            manage(self.db, self.state, "allow-access", "home", ["direct", "extra"])
        secret = (self.state / "tokens" / "edge").read_bytes()
        rev, cfg = config(self.db)
        previous = cfg["routes"].pop()
        cfg["nodes"][0]["source"] = "simulated"
        with self.db:
            rev = save_config(self.db, self.state, dict(**cfg, revision=rev))
        self.assertNotEqual((self.state / "tokens" / "edge").read_bytes(), secret)
        cfg["routes"].append(previous)
        with self.db:
            save_config(self.db, self.state, dict(**cfg, revision=rev))
        status, _, body = self.request("/api/v1/tasks?reporter=access.home", identity="access.home")
        self.assertEqual((status, list(json.loads(body)["profiles"])), (200, ["direct"]))

    def test_probe_history_survives_detach_and_is_separate_for_each_source(self):
        token = self.state / "tokens" / "edge"
        original = token.read_bytes()
        at = now_ms()

        def change(kind, source=None):
            rev, cfg = config(self.db)
            cfg["nodes"][0].update(kind=kind, source=source)
            with self.db:
                save_config(self.db, self.state, {**cfg, "revision": rev})
            self.assertIsNone(self.db.execute("SELECT 1 FROM latest WHERE kind='host' AND id='edge'").fetchone())

        def active_cpu():
            return [row[0] for row in self.db.execute(
                "SELECT json_extract(body,'$.cpu') FROM samples WHERE kind='host' AND id='edge' ORDER BY at"
            )]

        with self.db:
            write_sample(self.db, "host", "edge", at, {"cpu": 12})
        change("shared")
        self.assertFalse(token.exists())
        self.assertEqual(active_cpu(), [12])
        change("agent", "simulated")
        self.assertNotEqual(token.read_bytes(), original)
        self.assertEqual(active_cpu(), [])
        with self.db:
            write_sample(self.db, "host", "edge", at, {"cpu": 86})
        change("agent", "system")
        self.assertEqual(active_cpu(), [12])
        change("agent", "simulated")
        self.assertEqual(active_cpu(), [86])
        rev, _ = config(self.db)
        with self.db:
            save_config(self.db, self.state, {"nodes": [], "links": [], "routes": [], "revision": rev})
        self.assertFalse(self.db.execute("SELECT 1 FROM samples WHERE id='edge'").fetchone())
        self.assertFalse(token.exists())

    def test_detail_history_is_computed_once_per_minute_and_revision(self):
        calls = []

        def counted(db, kind, key, end, minutes, version=None, carrier=None):
            calls.append((minutes, end))
            return latency_bars(db, kind, key, end, minutes, version, carrier)

        url = "/api/v1/history?kind=summary&id=direct&minutes=60&resolution=bars"
        with patch("server.latency_bars", counted):
            first, second = self.request(url)[2], self.request(url)[2]
            self.assertEqual(first, second)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][1] % 60_000, 0)
            self.assertLess(abs(calls[0][1] - now_ms()), 61_000)
            with self.db:
                self.db.execute("UPDATE config SET rev=rev+1 WHERE id=1")
            self.request(url)
            self.assertEqual(len(calls), 2)
            for _ in range(2):
                self.request(url.replace("minutes=60", "minutes=5"))
            self.assertEqual([minutes for minutes, _ in calls], [60, 60, 5, 5])

    def test_archived_detail_uses_the_cutoff_shown_by_its_measuring_version(self):
        closed = (now_ms() // 60_000 - 1) * 60_000 + 20_000
        revision, cfg = config(self.db)
        route = next(r for r in cfg["routes"] if r["id"] == "direct")
        version = route["version"]
        route["testUrl"] = "https://new.example.test/204"
        with self.db, patch("store.now_ms", return_value=closed):
            save_config(self.db, self.state, {**cfg, "revision": revision})
            for offset, delay in ((-100, 8), (2000, 90)):
                write_sample(self.db, "reference", "edge/zj-cu-icmp", closed + offset, {"latency": delay})
            write_sample(self.db, "route", f"direct@{version}", closed + 1000, {"latency": 10}, historical=True)
        versions = json.loads(self.request("/api/v1/versions?kind=route&id=direct")[2])
        self.assertEqual(versions[-1]["end"], closed + 1000)
        url = "/api/v1/history?kind=reference&id=edge%2Fzj-cu-icmp&minutes=60&resolution=bars"
        with patch("server.now_ms", return_value=closed + 3000):
            live = json.loads(self.request(url)[2])
            self.assertEqual(live["stats"]["max"], 90)
            with patch("server.latency_bars", wraps=latency_bars) as compute:
                archived = url + f"&archive=route/direct/{version}"
                for cutoff in (closed, versions[-1]["end"], versions[-1]["end"]):
                    result = json.loads(self.request(archived + f"&end={cutoff}")[2])
                    self.assertEqual((result["end"], result["stats"]["max"]), (cutoff, 8))
                self.assertEqual(compute.call_count, 2)
            self.assertEqual(len(self.app.histories.hot), 1)
            self.assertEqual(self.request(url + "&archive=route/direct/9999")[0], 404)

    def test_series_beyond_warm_budget_still_share_foreground_results(self):
        cache = HistoryCache(self.state)
        with patch("server.HISTORY_HOT_LIMIT", 1), patch("server.now_ms", return_value=600_005):
            for key in ("cpu", "net"):
                cache.get(self.db, (1, key), 600_005, lambda db, end: end)
            self.assertEqual(set(cache.hot), {(1, "cpu")})
            self.assertEqual(cache.get(self.db, (1, "net"), 600_005, lambda *_: self.fail()), 660_000)

    def test_history_cache_answers_with_the_last_minute_and_warms_live_series(self):
        cache, computed = HistoryCache(self.state), []

        def compute(db, end):
            computed.append(end)
            return {"end": end}

        revision = self.db.execute("SELECT rev FROM config WHERE id=1").fetchone()[0]
        series = (revision, "bars", "link", "x", 60, None, None)
        stale = (revision + 1, *series[1:])
        with patch("server.now_ms", return_value=600_005):
            self.assertEqual(cache.get(self.db, series, 600_005, compute), {"end": 660_000})
        with patch("server.now_ms", return_value=660_005):
            # The new minute is not ready, so the last one answers at once and the new one is queued.
            self.assertEqual(cache.get(self.db, series, 660_005, compute), {"end": 660_000})
            self.assertEqual(computed, [660_000])
            cache.get(self.db, stale, 660_005, compute)
            # An archived end is computed once at its own minute and is never warmed.
            cache.get(self.db, (revision, "bars", "link", "x", 60, 1, None), 100_000, compute)
            computed.clear()
            cache.warm_once(self.db)
            self.assertEqual(computed, [720_000])
            self.assertEqual(set(cache.hot), {series})
            self.assertEqual(cache.get(self.db, series, 660_005, compute), {"end": 720_000})
        with patch("server.now_ms", return_value=660_005 + 600_001):
            cache.warm_once(self.db)
        self.assertEqual((cache.hot, computed), ({}, [720_000]))
