import os
import tempfile
import sys
import unittest
from datetime import datetime, timezone
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import tasks
from dashboard import LATENCY_FRESH, history, host_averages, latency_bars, latency_baseline, record_summaries, snapshot
from store import (
    FRESH,
    GIB,
    Invalid,
    billing_period,
    config,
    connect,
    ingest,
    init,
    meter_update,
    now_ms,
    save_config,
    write_sample,
)


class ReportTests(unittest.TestCase):
    def test_host_averages_include_every_raw_sample_per_metric(self):
        with closing(connect(self.state)) as db, db:
            start = self.at - 1_800_000
            for i in range(360):
                body = {"cpu": 100 * (i % 2), "up": i, "disk": 0}
                if i == 10:
                    body["ram"] = 31
                write_sample(db, "host", "hk-relay", start + (i + 1) * 5000, body)
            write_sample(db, "host", "lax", self.at, {"cpu": 99})
            series = host_averages(db, "hk-relay", self.at)
            self.assertEqual((len(series["points"]), series["step"]), (48, 1_800_000))
            self.assertTrue(all(p["v"] is None for p in series["points"][:-1]))
            self.assertEqual(series["points"][-1]["v"], {"cpu": 50, "ram": 31, "disk": 0, "up": 179.5, "down": None})

    def test_baseline_counts_distinct_five_minute_slices(self):
        with closing(connect(self.state)) as db, db:
            start = self.at // 300_000 * 300_000 - 12 * 300_000
            for i in range(12):
                for j in range(6):
                    write_sample(db, "summary", "test@1", start + i * 300_000 + j * 5000, {"segmentSum": 40})
            self.assertIsNone(latency_baseline(db, "summary", "test@1", start + 330_000, "$.segmentSum"))
            self.assertEqual(latency_baseline(db, "summary", "test@1", self.at, "$.segmentSum"), 40)

    def test_route_bars_follow_selected_carrier_and_shared_tail(self):
        with closing(connect(self.state)) as db, db:
            graph = tasks.mesh(config(db)[1])
            route = graph["routes"]["hk-main"]
            carrier = "gz/zj-cu-icmp"
            other = "gz/zj-ct-icmp"
            for i in range(10):
                at = self.at - 285_000 + i * 30_000
                for ref in (carrier, other):
                    write_sample(db, "reference", ref, at, {"latency": 10, "packetLoss": 33.33 if ref == carrier else 0})
                for key in route["tail"]:
                    stored = tasks.series_id(key, graph["links"][key]["version"])
                    bad = i >= 8 and key == "hk-hk"
                    write_sample(db, "link", stored, at, {"latency": None if bad else 20, "packetLoss": 100 if bad else 0})
                sums = {carrier: None if i >= 8 else 50, other: None if i >= 8 else 50}
                write_sample(db, "summary", tasks.series_id("hk-main", route["version"]), at + 100, {"estimates": sums})
            for minutes in (5, 60, 1440):
                result = {}
                for ref in (carrier, other):
                    bars = latency_bars(db, "summary", "hk-main", self.at, minutes, carrier=ref)
                    result[ref] = [p for p in bars["points"] if p["n"]]
                    self.assertIsNone(bars["stats"]["loss"])
                expected = {
                    5: ["mint"] * 2 + ["amber"] * 6 + ["rose"] * 2,
                    60: ["mint"] + ["amber"] * 3 + ["rose"],
                    1440: ["amber"],
                }
                self.assertEqual([p["status"] for p in result[carrier]], expected[minutes])
                if minutes < 1440:
                    self.assertEqual((result[other][0]["status"], result[other][-1]["status"]), ("mint", "rose"))
                    self.assertIsNone(result[other][-1]["p50"])
                else:
                    self.assertEqual(result[other][0]["status"], "amber")

    @patch.dict(os.environ, {"LINKSCOPE_FIXED_INGRESS": "zhejiang"})
    def test_fixed_loss_alerts_persist_until_recovery_and_restart_after_gaps(self):
        series = "gz/zj-ct-icmp"
        start = self.at - 25 * 30_000
        rounds = [
            (0, 0, "normal"), (1, 66.67, "normal"), (2, 0, "normal"), (3, 33.33, "normal"),
            (4, 0, "normal"), (5, 33.33, "warning"), (6, 0, "warning"), (7, 0, "warning"),
            (8, 33.33, "warning"), (9, 0, "warning"), (10, 0, "warning"), (11, 33.33, "warning"),
            (12, 0, "warning"), (13, 0, "warning"), (14, 0, "normal"), (15, 100, "warning"),
            (16, 100, "critical"), (17, 100, "critical"), (18, 0, "warning"), (19, 0, "warning"),
            (20, 0, "normal"), (21, 100, "warning"), (23, 100, "warning"), (24, None, None),
            (25, 66.67, "normal"),
        ]
        tones = {"normal": "mint", "warning": "amber", "critical": "rose", None: "gap"}
        with closing(connect(self.state)) as db, db:
            for i, loss, expected in rounds:
                at = start + i * 30_000
                sample = {"packetLoss": loss, "latency": 10 if loss not in (None, 100) else None}
                write_sample(db, "reference", series, at, sample)
                write_sample(db, "reference", "gz/zj-cu-icmp", at, {"latency": 10, "packetLoss": 0})
                frame = snapshot(db, at)
                link = next(l for l in frame["links"] if l.get("referenceId") == series)
                self.assertEqual((link["reading"]["packetLoss"], link["reading"]["lossAlert"]), (loss, expected), i)
                self.assertEqual(link["measured"], loss is not None, i)
                self.assertEqual(frame["summaries"]["all"]["faults"], int(expected in ("warning", "critical")), i)
            # Each five-minute view starts after the original trigger and recovers its preceding state.
            for last in (19, 25):
                bars = latency_bars(db, "reference", series, start + last * 30_000, 5)
                actual = [(p["t"], p["loss"], p["status"]) for p in bars["points"] if p["n"]]
                expected = [(start + i * 30_000, loss, tones[level]) for i, loss, level in rounds if last - 10 < i <= last]
                self.assertEqual(actual, expected)

    def test_raw_history_keeps_jittered_samples_failures_and_true_outages(self):
        with closing(connect(self.state)) as db, db:
            for offset, latency in [(2490, 4), (7510, 5), (12495, None), (17505, 6), (39000, 7)]:
                write_sample(db, "host", "test", self.at + offset, {"latency": latency})
            points = history(db, "host", "test", self.at + 45000, 45000, 10, raw=True)
            self.assertEqual(
                [p["at"] - self.at for p in points if "at" in p], [2490, 7510, 12495, 17505, 39000]
            )
            self.assertEqual(len([p for p in points[1:-1] if "at" not in p]), 1)
            self.assertIsNone(points[3]["v"]["latency"])

    def test_tcp_loss_counts_timeouts_excludes_unknown_and_expired_results(self):
        with closing(connect(self.state)) as db, db:
            link = next(l for l in config(db)[1]["links"] if l["id"] == "hk-jp")
            for offset, outcome in [(-60100, 100), (-20000, 100), (-10000, 0), (-8000, None)]:
                sample = {"latency": None, "failureRate": 100, "tcpTimeout": outcome}
                write_sample(db, "link", tasks.series_id("hk-jp", link["version"]), self.at + offset, sample)
            write_sample(
                db,
                "link",
                tasks.series_id("hk-jp", link["version"]),
                self.at,
                {"latency": 5, "failureRate": 0},
            )
            for offset, rate, state, faults in [(0, 100 / 3, "degraded", 1), (40_001, 0, "normal", 0)]:
                frame = snapshot(db, self.at + offset)
                link = next(l for l in frame["links"] if l["id"] == "hk-jp")
                self.assertAlmostEqual(link["reading"]["tcpLoss"], rate)
                self.assertEqual(link["state"], state)
                self.assertEqual(frame["summaries"]["all"]["faults"], faults)
                self.assertEqual(frame["summaries"]["jp-main"]["faults"], faults)
            version = link["version"]
            write_sample(db, "link", tasks.series_id("hk-jp", version + 1), self.at - 1000, {"tcpTimeout": 100})
            for raw in (True, False):
                points = history(db, "link", "hk-jp", self.at, 9000, 2, version, raw, rate_metric="tcpLoss")
                rates = [p["v"]["tcpLoss"] for p in points if p.get("at")]
                self.assertEqual(len(rates), 2)
                self.assertAlmostEqual(rates[0], 200 / 3)
                self.assertAlmostEqual(rates[1], 100 / 3)
            write_sample(db, "link", tasks.series_id("hk-jp", version), self.at + 60_000, {"failureRate": 100})
            end = self.at + 60_000
            points = history(db, "link", "hk-jp", end, 1000, 2, version, raw=True, rate_metric="tcpLoss")
            self.assertEqual([p["v"] for p in points if p.get("at")], [{"tcpLoss": None}])

    def test_latency_history_allows_thirty_second_rounds_and_marks_a_missed_round(self):
        with closing(connect(self.state)) as db, db:
            for kind in ("link", "route", "reference"):
                key = "example" if kind == "reference" else tasks.series_id("example", 1)
                for offset in (1_000, 30_800, 62_500, 125_000):
                    write_sample(db, kind, key, self.at + offset, {"latency": 10})
                series = history(db, kind, "example", self.at + 126_000, 126_000, 10, version=1, raw=True)
                self.assertEqual([p["v"] is None for p in series[1:-1]], [False, False, False, True, False])

    def test_latency_bars_use_bucket_medians_daily_baseline_and_worst_outcome(self):
        with closing(connect(self.state)) as db, db:
            link = next(l for l in config(db)[1]["links"] if l["id"] == "hk-hk")
            series = tasks.series_id("hk-hk", link["version"])
            start = self.at - 3_600_000
            # The baseline reads one slice of every five minutes, so seed earlier rounds on those slices.
            aligned = (start - 3 * 3_600_000) // 300_000 * 300_000
            for k in range(24):
                write_sample(db, "link", series, aligned + k * 300_000, {"latency": 40.0, "packetLoss": 0})
            for i in range(120):
                t = start + 15_000 + i * 30_000
                minute = i // 2
                if minute == 30 or i == 115:
                    continue
                body = {"latency": 40.0, "packetLoss": 0}
                if minute == 10:
                    body["latency"] = 80.0
                elif minute == 20:
                    body = {"latency": 41.0, "packetLoss": 33.33}
                elif minute == 40 and i % 2:
                    body = {"latency": None, "packetLoss": 100}
                write_sample(db, "link", series, t, body)
            bars = latency_bars(db, "link", "hk-hk", self.at, 60)
            self.assertEqual(bars["baseline"], 40)
            self.assertEqual(len(bars["points"]), 60)
            self.assertEqual(
                {i: p["status"] for i, p in enumerate(bars["points"]) if p["status"] != "mint"},
                {10: "amber", 20: "rose", 30: "gap", 40: "amber"},
            )
            self.assertEqual((bars["points"][10]["p50"], bars["points"][10]["high"]), (80, 2))
            self.assertEqual((bars["points"][40]["fails"], bars["points"][40]["loss"]), (1, 50))
            self.assertEqual((bars["stats"]["p50"], bars["stats"]["max"]), (40, 80))
            # One lossy round stays amber at every zoom instead of turning rose in short bars only.
            day = latency_bars(db, "link", "hk-hk", self.at, 1440)
            self.assertEqual([p["status"] for p in day["points"][-2:]], ["amber", "amber"])
            rounds = latency_bars(db, "link", "hk-hk", self.at, 5)
            self.assertEqual(rounds["step"], 30_000)
            self.assertEqual([p["status"] for p in rounds["points"]], ["mint"] * 5 + ["gap"] + ["mint"] * 4)

    def test_latency_far_above_the_daily_median_degrades_the_link(self):
        with closing(connect(self.state)) as db, db:
            link = next(l for l in config(db)[1]["links"] if l["id"] == "hk-hk")
            series = tasks.series_id("hk-hk", link["version"])

            def state(at, latency):
                write_sample(db, "link", series, at, {"latency": latency, "packetLoss": 0})
                frame = snapshot(db, at + 1000)
                l = next(l for l in frame["links"] if l["id"] == "hk-hk")
                return l["state"], l["elevated"], frame["summaries"]["all"]["faults"]

            early = self.at - 900_000
            aligned = (early - 4 * 3_600_000) // 300_000 * 300_000
            for i in range(5):
                write_sample(db, "link", series, aligned + i * 300_000, {"latency": 40.0, "packetLoss": 0})
            self.assertEqual(state(early, 75.0), ("normal", False, 0))
            for i in range(5, 30):
                write_sample(db, "link", series, aligned + i * 300_000, {"latency": 40.0, "packetLoss": 0})
            self.assertEqual(state(self.at, 44.0), ("normal", False, 0))
            self.assertEqual(state(self.at + 30_000, 75.0), ("degraded", True, 1))

    def test_max_uses_period_totals_and_rolls_at_the_utc_billing_day(self):
        n = {"id": "hk-relay", "direction": "max", "resetDay": 31}
        at = int(datetime(2026, 2, 27, 23, 59, 50, tzinfo=timezone.utc).timestamp() * 1000)
        self.assertNotEqual(billing_period(at, 31), billing_period(at + 10_000, 31))
        with closing(connect(self.state)) as db, db:
            db.execute("UPDATE meter SET used=0 WHERE id='hk-relay'")

            def read(t, tx, rx):
                meter_update(db, n, dict(txBytes=tx, rxBytes=rx, boot=1, nic="eth0"), at + t)
                return db.execute("SELECT used FROM meter WHERE id='hk-relay'").fetchone()[0]

            self.assertEqual(read(0, 1000, 2000), 0)
            self.assertEqual(read(4000, 1040, 2010), 40)
            self.assertEqual(read(8000, 1045, 2060), 60)
            self.assertEqual(read(12000, 1050, 2061), 5)

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.state = Path(temp.name)
        init(self.state, ROOT / "examples/topology.json")
        self.at = now_ms() - 1000

    def send(self, reporter, t, **parts):
        token = (self.state / "tokens" / reporter).read_text()
        with closing(connect(self.state)) as db, db:
            cfg = config(db)[1]
            graph = tasks.mesh(cfg)
            for group, kind in (("links", "link"), ("routes", "route")):
                for key, reading in parts.get(group, {}).items():
                    task = tasks.definition(kind, graph[group][key], graph)
                    parts[group][key] = {**{k: task[k] for k in ("version", "observer", "target")}, **reading}
            if "sessions" in parts:
                parts.setdefault(
                    "routeVersions",
                    {r["id"]: r["version"] for r in cfg["routes"] if r["testSource"] == "simulated"},
                )
            ingest(
                db,
                self.state,
                token,
                dict(
                    reporter=reporter,
                    at=self.at + t,
                    source="system" if reporter == "local" else "simulated",
                    **parts,
                ),
            )

    def current(self, offset=3):
        with closing(connect(self.state)) as db:
            return snapshot(db, self.at + offset)

    def test_quota_deltas_retries_boot_and_calibration(self):
        host = {"boot": 1, "nic": "eth0", "txBytes": GIB, "rxBytes": 2 * GIB}
        self.send("hk-relay", 0, host=host)
        host.update(txBytes=2 * GIB, rxBytes=4 * GIB)
        self.send("hk-relay", 1, host=host)
        self.send("hk-relay", 1, host=host)
        with self.assertRaises(Invalid):
            self.send("hk-relay", 0, host=host)

        def remaining():
            return next(n["remaining"] for n in self.current()["nodes"] if n["id"] == "hk-relay")

        remaining_after_transfer = 1024 - 256 - 3
        self.assertEqual(remaining(), remaining_after_transfer)
        init(self.state, None)
        self.assertEqual(remaining(), remaining_after_transfer)
        self.send("hk-relay", 2, host={**host, "boot": 2, "txBytes": GIB, "rxBytes": 0})
        self.assertEqual(remaining(), remaining_after_transfer - 1)
        with closing(connect(self.state)) as db, db:
            rev, cfg = config(db)
            node = next(n for n in cfg["nodes"] if n["id"] == "hk-relay")
            node.update(usedGiB=0, direction="up")
            save_config(db, self.state, dict(**cfg, revision=rev, resetUsage=["hk-relay"]))
        self.send("hk-relay", 3, host={**host, "boot": 2, "txBytes": 2 * GIB, "rxBytes": 9 * GIB})
        self.assertEqual(remaining(), 1023)

    def test_unlimited_host_and_manually_metered_shared_quota(self):
        with closing(connect(self.state)) as db, db:
            rev, cfg = config(db)
            host = next(n for n in cfg["nodes"] if n["id"] == "hk-relay")
            shared = next(n for n in cfg["nodes"] if n["id"] == "jp")
            host.update(unlimited=True, quotaGiB=None)
            shared.update(quotaGiB=200, direction="single")
            rev = save_config(db, self.state, dict(**cfg, revision=rev))
            db.commit()
            nodes = {n["id"]: n for n in snapshot(db)["nodes"]}
            self.assertTrue(nodes["hk-relay"]["unlimited"])
            self.assertIsNone(nodes["hk-relay"]["remaining"])
            self.assertEqual(nodes["hk-relay"]["usedGiB"], 256)
            self.assertIsNone(nodes["jp"]["remaining"])
            self.assertEqual((nodes["jp"]["quotaGiB"], nodes["jp"]["direction"]), (200, "single"))
            shared["usedGiB"] = 80
            rev = save_config(db, self.state, dict(**cfg, revision=rev))
            remaining = next(n["remaining"] for n in snapshot(db)["nodes"] if n["id"] == "jp")
            self.assertEqual(remaining, 120)
            host["direction"] = "single"
            with self.assertRaisesRegex(Invalid, "计费方向"):
                save_config(db, self.state, dict(**cfg, revision=rev))
            host.update(direction="both", quotaGiB=100)
            with self.assertRaisesRegex(Invalid, "不能同时"):
                save_config(db, self.state, dict(**cfg, revision=rev))

    @patch.dict(os.environ, {"LINKSCOPE_ROUTE_TESTS": "1"})
    def test_real_reports_drive_scoped_results_history_and_expiry(self):
        self.assertIsNone(self.current()["summaries"]["us-main"]["delay"])
        sessions = [
            dict(
                ip="2001:db8::1",
                entry="sh",
                mode="TCP",
                latency=4,
                failureRate=0,
                traffic={"us-main": {"forward": 7, "reverse": 9}, "jp-main": {"forward": 3, "reverse": 6}},
            )
        ]
        self.send("client", 0, routes={"us-main": {"status": "timeout"}}, sessions=sessions)
        self.send("client", 1, routes={"us-main": {"status": "ok", "latency": 183.5}}, sessions=sessions)
        self.send("lax", 0, host={"cpu": 27}, links={"la-sjc": {"packetLoss": 100}})
        snap = self.current()
        route = snap["summaries"]["us-main"]
        self.assertEqual(
            (183.5, 50, 7, 2, 3, 1),
            tuple(route[k] for k in ("delay", "success", "upload", "measured", "segments", "faults")),
        )
        self.assertEqual(snap["summaries"]["jp-main"]["upload"], 3)
        self.assertEqual(next(n for n in snap["nodes"] if n.get("sourceIp"))["place"], "地区未知")
        self.assertIsNone(snap["summaries"]["hk-backup"]["delay"])
        between = self.current(30_000)
        self.assertEqual(between["summaries"]["us-main"]["delay"], 183.5)
        self.assertTrue(next(l["measured"] for l in between["links"] if l["id"] == "la-sjc"))
        expired_host = self.current(FRESH + 10)
        self.assertEqual(next(n["state"] for n in expired_host["nodes"] if n["id"] == "lax"), "offline")
        self.assertFalse(any(n.get("sourceIp") for n in expired_host["nodes"]))
        expired = self.current(LATENCY_FRESH + 10)
        self.assertIsNone(expired["summaries"]["us-main"]["delay"])
        self.assertFalse(next(l["measured"] for l in expired["links"] if l["id"] == "la-sjc"))
        with closing(connect(self.state)) as db:
            points = history(db, "host", "lax", self.at + 5, 300_000, 61)
            self.assertEqual([p["v"]["cpu"] for p in points if p["v"]], [27])

    def test_direct_visitor_line_takes_a_free_lane_through_skipped_columns(self):
        sessions = [dict(ip="2001:db8::7", entry="sjc", traffic={"us-direct": {"forward": 4, "reverse": 6}})]
        self.send("client", 0, sessions=sessions)
        snap = self.current()
        nodes = {n["id"]: n for n in snap["nodes"]}
        link = next(l for l in snap["links"] if l.get("sourceIp") and l["to"] == "sjc")
        self.assertTrue(link["direct"])
        self.assertEqual([v["col"] for v in link["via"]], list(range(1, nodes["sjc"]["col"])))
        for slot in link["via"]:
            rows = [n["row"] for n in nodes.values() if n["col"] == slot["col"] and n.get("row") is not None]
            self.assertTrue(rows)
            self.assertGreater(min(abs(r - slot["row"]) for r in rows), 0.2)

    def test_direct_visitors_to_the_same_entry_get_separate_lanes(self):
        sessions = [
            dict(ip=ip, entry="sjc", traffic={"us-direct": {"forward": 4, "reverse": 6}})
            for ip in ("192.0.2.10", "192.0.2.20")
        ]
        self.send("client", 0, sessions=sessions)
        left, right = [link["via"] for link in self.current()["links"] if link.get("sourceIp")]
        self.assertTrue(left)
        self.assertEqual([p["col"] for p in left], [p["col"] for p in right])
        for a, b in zip(left, right):
            self.assertNotEqual(a["row"], b["row"])

    @patch.dict(os.environ, {"LINKSCOPE_FIXED_INGRESS": "zhejiang", "LINKSCOPE_ROUTE_TESTS": ""})
    def test_segments_continue_without_the_route_client(self):
        old_result = {"jp-main": {"status": "ok", "latency": 350}}
        with patch.dict(os.environ, {"LINKSCOPE_ROUTE_TESTS": "1"}):
            self.send("client", 0, routes=old_result)
        with self.assertRaisesRegex(Invalid, "整线测试已关闭"):
            self.send("client", 1, routes=old_result)
        with closing(connect(self.state)) as db, db:
            cfg = config(db)[1]
            self.assertFalse(tasks.assignments(cfg, "client", "simulated")["routes"])
            self.assertIn("hk-jp", tasks.assignments(cfg, "hk-relay", "simulated")["links"])
            for code, latency in (("ct", 8), ("cu", 12)):
                write_sample(db, "reference", f"sh/zj-{code}-icmp", self.at, {"latency": latency, "packetLoss": 0})
        self.send("hk-relay", 0, links={"sh-hk": {"latency": 20, "packetLoss": 0}})
        self.assertIsNone(self.current()["summaries"]["jp-main"]["estimates"]["sh/zj-cu-icmp"])
        self.send("hk-relay", 1, links={"hk-jp": {"latency": 90, "failureRate": 0, "tcpTimeout": 0}})
        summary = self.current()["summaries"]["jp-main"]
        self.assertEqual(summary["segmentSum"], 110)
        self.assertEqual(summary["estimates"], {"sh/zj-ct-icmp": 118, "sh/zj-cu-icmp": 122})
        self.assertTrue(all(summary[key] is None for key in ("delay", "success", "status")))
        with closing(connect(self.state)) as db, db:
            record_summaries(db, {})
            rows = history(db, "summary", "jp-main", now_ms(), 300_000, 61, raw=True)
            sample = next(p["v"] for p in rows if p.get("at"))
            self.assertEqual(sample["segmentSum"], 110)
            self.assertEqual(sample["estimates"], summary["estimates"])
            self.assertNotIn("delay", sample)
        self.send("hk-relay", 2, links={"hk-jp": {"failureRate": 100, "tcpTimeout": 100}})
        self.assertIsNone(self.current()["summaries"]["jp-main"]["estimates"]["sh/zj-ct-icmp"])
        self.assertIsNone(self.current()["summaries"]["us-direct"]["segmentSum"])

    @patch.dict(os.environ, {"LINKSCOPE_ROUTE_TESTS": "1"})
    def test_rejected_batch_is_atomic_and_edits_invalidate_old_paths(self):
        with self.assertRaises(Invalid):
            self.send("hk", 0, host={"cpu": 46}, links={"gz-hk": {"latency": 88}})
        self.assertIsNone(next(n["last"] for n in self.current()["nodes"] if n["id"] == "hk"))
        self.send(
            "client",
            1,
            routes={"us-main": {"status": "ok", "latency": 184}},
            sessions=[dict(ip="192.0.2.9", entry="sh", traffic={"us-main": {"forward": 2, "reverse": 5}})],
        )
        with closing(connect(self.state)) as db, db:
            rev, cfg = config(db)
            route = next(r for r in cfg["routes"] if r["id"] == "us-main")
            route["tail"] = ["sh-hk", "hk-jp"]
            save_config(db, self.state, dict(**cfg, revision=rev))
        summary = self.current()["summaries"]["us-main"]
        self.assertIsNone(summary["delay"])
        self.assertIsNone(summary["upload"])
        with closing(connect(self.state)) as db, db, self.assertRaises(Invalid):
            save_config(db, self.state, dict(**cfg, revision=rev))
        with closing(connect(self.state)) as db, db, self.assertRaises(Invalid):
            save_config(db, self.state, {**cfg, "revision": rev + 1, "links": []})
