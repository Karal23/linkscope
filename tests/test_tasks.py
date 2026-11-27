import json
import os
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import tasks
from dashboard import history, snapshot
from store import Invalid, config, connect, ingest, init, now_ms, save_config, write_sample


@patch.dict(os.environ, {"LINKSCOPE_ROUTE_TESTS": "1"})
class AssignmentTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.state = Path(temp.name)
        init(self.state, ROOT / "examples/topology.json")
        self.db = connect(self.state)
        self.addCleanup(self.db.close)
        self.at = now_ms() - 100
        self.token = (self.state / "tokens" / "client").read_text()

    def edit(self, change, **extra):
        revision, cfg = config(self.db)
        change(tasks.mesh(cfg))
        with self.db:
            return save_config(self.db, self.state, {**cfg, "revision": revision, **extra})

    def plan(self, reporter="client", source="simulated"):
        return tasks.assignments(config(self.db)[1], reporter, source)

    def report(self, task, n, latency):
        with self.db:
            ingest(
                self.db,
                self.state,
                self.token,
                dict(
                    reporter="client",
                    source=task["source"],
                    at=self.at + n,
                    routes={
                        "us-main": dict(
                            version=task["version"],
                            observer="client",
                            target=task["target"],
                            status="ok",
                            latency=latency,
                        )
                    },
                ),
            )

    def route(self):
        return snapshot(self.db, self.at + 60)["summaries"]["us-main"]

    def test_rewire_preserves_history_and_retires_only_unused_segments(self):
        original = self.plan()["routes"]["us-main"]
        self.assertEqual(original["path"], ["sh", "lax", "sjc"])
        self.report(original, 1, 182)
        hk = self.plan()["routes"]["hk-main"]["version"]
        self.edit(lambda g: g["routes"]["us-main"].update(tail=["sh-hk", "hk-jp"]))
        changed = self.plan()["routes"]["us-main"]
        self.assertEqual(changed["path"], ["sh", "hk-relay", "jp"])
        self.assertGreater(changed["version"], original["version"])
        self.assertEqual(hk, self.plan()["routes"]["hk-main"]["version"])
        self.assertNotIn("la-sjc", self.plan("lax")["links"])
        self.assertEqual(self.plan("hk-relay")["links"]["hk-jp"]["routeIds"], ["jp-main", "us-main"])
        self.assertEqual(self.route()["status"], "pending")
        self.report(original, 9, 900)
        self.assertIsNone(self.route()["delay"])
        self.report(changed, 4, 91)
        self.report(original, 2, 812)
        self.assertEqual(self.route()["delay"], 91)
        self.assertEqual(self.route()["success"], 100)
        for generation, expected in [(changed["version"], [91]), (original["version"], [182, 812, 900])]:
            pts = history(self.db, "route", "us-main", self.at + 20, 20, 21, generation)
            self.assertEqual([p["v"]["latency"] for p in pts if p["v"]], expected)
        self.edit(lambda g: g["routes"]["us-main"].update(name="仅改显示名称"))
        self.assertEqual(self.plan()["routes"]["us-main"]["version"], changed["version"])
        self.edit(lambda g: g["routes"]["us-main"].update(tail=original["links"]))
        self.assertGreater(self.plan()["routes"]["us-main"]["version"], changed["version"])
        self.assertEqual(self.route()["status"], "pending")
        self.assertIn("la-sjc", self.plan("lax")["links"])

    def test_archived_route_preserves_segment_versions_labels_and_old_entry(self):
        route = self.plan()["routes"]["hk-main"]
        v = route["version"]
        with self.db:
            write_sample(self.db, "summary", f"hk-main@{v}", self.at, {"estimates": {"gz/zj-cu-icmp": 55}})
        self.edit(lambda g: g["routes"]["hk-main"].update(entry="sh", tail=["sh-hk", "hk-jp"]))
        self.edit(lambda g: g["nodes"]["hk"].update(address="192.0.2.99", name="改名后"))
        for legacy in (False, True):
            if legacy:
                with self.db:
                    self.db.execute("""UPDATE task_history SET body=json_remove(body,'$.segments','$.entryName')
                                       WHERE kind='route' AND id='hk-main' AND version=?""", (v,))
            cfg = config(self.db)[1]
            archived = tasks.versions(self.db, "route", "hk-main", cfg)[-1]
            entry, segments = tasks.history_segments(self.db, cfg, "hk-main", v)
            self.assertEqual((entry, archived["entryName"]), ("gz", "广州入口"))
            self.assertEqual(segments, archived["segments"])
            self.assertEqual([(s["id"], s["version"]) for s in segments], [("gz-hk", v), ("hk-hk", v)])
            self.assertEqual(segments[-1]["label"], "香港中转 → 香港出口")
            self.assertEqual(archived["references"], [dict(id="gz/zj-cu-icmp", region="浙江", provider="联通")])
            self.assertEqual(set(segments[-1]), {"id", "version", "mode", "label"})

    def test_path_specific_proxy_and_probe_direction(self):
        url = "http://probe.invalid/204"
        first = "http://localhost:3101"
        second = "http://localhost:3102"
        self.edit(lambda g: g["routes"]["us-main"].update(testSource="system", testProxy=first, testUrl=url))
        original = self.plan(source="system")["routes"]["us-main"]
        self.edit(lambda g: g["routes"]["us-main"].update(entry="sjc", tail=[]))
        self.assertIsNone(self.plan(source="system")["routes"]["us-main"]["proxy"])
        self.edit(lambda g: g["routes"]["us-main"].update(testProxy=second))
        self.edit(lambda g: g["routes"]["us-main"].update(entry="sh", tail=original["links"]))
        self.assertEqual(self.plan(source="system")["routes"]["us-main"]["proxy"], first)
        self.assertNotIn("us-main", self.plan()["routes"])
        self.assertEqual(self.plan("hk-relay")["links"]["gz-hk"]["target"], "gz")
        self.edit(lambda g: g["nodes"]["gz"].update(address="127.0.0.1", port=8080))
        task = self.plan("hk-relay")["links"]["gz-hk"]
        self.assertEqual((task["host"], task["mode"], task["observer"]), ("127.0.0.1", "ICMP", "hk-relay"))
        for extra in [{}, {"version": task["version"], "observer": "hk-relay", "target": "jp"}]:
            with self.assertRaises(Invalid), self.db:
                ingest(
                    self.db,
                    self.state,
                    (self.state / "tokens" / "hk-relay").read_text(),
                    dict(
                        reporter="hk-relay",
                        source="simulated",
                        at=self.at + 1,
                        links={"gz-hk": {**extra, "latency": 66}},
                    ),
                )
        self.edit(lambda g: g["links"]["hk-hk"].update(observer="hk"))
        self.assertNotIn("hk-hk", self.plan("hk-relay")["links"])
        self.assertEqual(self.plan("hk")["links"]["hk-hk"]["target"], "hk-relay")

    def test_explicitly_remapped_proxy_is_not_reused_for_its_old_path(self):
        listener = "http://localhost:3210"
        self.edit(
            lambda g: g["routes"]["us-main"].update(
                testSource="system", testUrl="http://test.invalid/204", testProxy=listener
            )
        )
        before = self.plan(source="system")["routes"]["us-main"]
        self.edit(lambda g: g["routes"]["us-main"].update(entry="sjc", tail=[]), bindProxy=["us-main"])
        self.assertEqual(self.plan(source="system")["routes"]["us-main"]["proxy"], listener)
        with self.assertRaises(Invalid):
            self.edit(
                lambda g: g["routes"]["jp-main"].update(
                    testSource="system", testUrl=before["url"], testProxy=listener
                )
            )
        self.edit(lambda g: g["routes"]["us-main"].update(entry="sh", tail=before["links"]))
        self.assertIsNone(self.plan(source="system")["routes"]["us-main"]["proxy"])

    def test_migrated_samples_are_only_in_v0_and_survive_restart(self):
        rev, cfg = config(self.db)
        for item in cfg["routes"] + cfg["links"]:
            item.pop("version")
            item.pop("allowLocalChecks")
        with self.db:
            self.db.execute("UPDATE config SET body=?", (json.dumps(cfg),))
            self.db.execute("PRAGMA user_version=0")
            write_sample(
                self.db, "route", "us-main", self.at, dict(status="ok", latency=199, source="simulated")
            )
        init(self.state, None)
        self.assertEqual(self.route()["status"], "pending")
        pts = history(self.db, "route", "us-main", self.at + 10, 100, 11, 0)
        self.assertEqual([p["v"]["latency"] for p in pts if p["v"]], [199])
        self.assertEqual(
            [r["version"] for r in tasks.versions(self.db, "route", "us-main", config(self.db)[1])], [rev, 0]
        )
        init(self.state, None)
        self.assertEqual(self.plan()["routes"]["us-main"]["version"], rev)
