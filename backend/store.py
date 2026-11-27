import calendar
import hashlib
import ipaddress
import json
import math
import re
import secrets
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import tasks

GIB = 1024**3
DAY = 86_400_000
FRESH = 15_000
COLORS = ("mint", "blue", "violet", "rose", "neutral")
KINDS = ("agent", "ingress", "ping", "shared")
EMPTY = {"nodes": [], "links": [], "routes": []}


def now_ms():
    return time.time_ns() // 1_000_000


class Invalid(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def check(ok, message, status=400):
    if not ok:
        raise Invalid(message, status)


def number(value, label, high=1e15):
    check(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= high, f"{label} 数值无效")
    return value


def word(value, label, limit=120):
    check(isinstance(value, str) and 0 < len(value.strip()) <= limit, f"请填写有效的{label}")
    return value.strip()


def choice(value, allowed, label):
    check(value in allowed, f"{label} 选项无效")
    return value


def obj(value, label):
    check(isinstance(value, dict), f"{label} 格式无效")
    return value


def items(value, label, limit=256):
    check(isinstance(value, list) and len(value) <= limit, f"{label} 列表无效")
    return value


def host_address(value):
    if value is None or value == "":
        return None
    value = word(value, "探测地址", 253)
    try:
        addr = ipaddress.ip_address(value)
        check("%" not in value, "探测地址不能带作用域")
        return str(addr)
    except ValueError:
        pass
    labels = value.rstrip(".").split(".")
    check(
        all(re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", label) for label in labels),
        "探测地址请填写单个 IP 或主机名",
    )
    return value.lower()


def test_address(value, proxy=False):
    if value is None or value == "":
        return None
    value = word(value, "测试代理" if proxy else "204 地址", 1024)
    try:
        url = urlsplit(value)
        port = url.port
        check(
            url.scheme in (("http",) if proxy else ("http", "https"))
            and url.hostname
            and url.username is None
            and url.password is None
            and not url.fragment
            and (not proxy or (url.path in ("", "/") and not url.query))
            and (port is None or port > 0)
            and not re.search(r"[\s\x00-\x1f\x7f]", value),
            "请填写有效的 HTTP 代理或 HTTP(S) 204 测试地址",
        )
        host_address(url.hostname)
    except ValueError:
        raise Invalid("测试地址无效")
    return value.rstrip("/") if proxy else value


def validated_config(raw):
    obj(raw, "拓扑")
    groups = {}
    for group in EMPTY:
        values = {}
        for item in items(raw.get(group), group):
            obj(item, group)
            key = item.get("id")
            check(
                isinstance(key, str)
                and re.fullmatch(r"[a-z][a-z0-9_-]{0,39}", key)
                and not key.startswith("peer-")
                and key not in ("all", "client"),
                "ID 需以小写字母开头，可含数字、短横线和下划线",
            )
            check(key not in values, f"ID 重复 {key}")
            values[key] = {
                "id": key,
                "name": word(item.get("name"), "名称", 64),
                "tone": choice(item.get("tone", "mint"), COLORS, "颜色"),
            }
            v = values[key]
            if group == "nodes":
                kind = choice(item.get("kind"), KINDS, "节点类型")
                cc = item.get("countryCode") or ""
                check(
                    isinstance(cc, str) and (not cc or re.fullmatch(r"[A-Za-z]{2}", cc)),
                    "国家或地区代码需为两位字母",
                )
                v.update(
                    kind=kind,
                    countryCode=cc.upper(),
                    icon=choice(
                        item.get("icon", "server"), ("globe", "server", "router", "relay", "home"), "图标"
                    ),
                    place=word(item.get("place") or "未知", "地区", 60),
                    provider=word(item.get("provider") or "未知", "服务商", 64),
                    role=word(item.get("role") or "节点", "角色", 40),
                    source=choice(item.get("source", "system"), ("system", "simulated"), "上报来源")
                    if kind == "agent"
                    else None,
                    direction=choice(
                        item.get("direction", "both"),
                        ("up", "down", "both", "max") + (("single",) if kind == "shared" else ()),
                        "计费方向",
                    ),
                )
                port = item.get("port")
                day = item.get("resetDay")
                check(day is None or (type(day) is int and 1 <= day <= 31), "每月重置日应为 1–31")
                v["resetDay"] = day
                check(port is None or (type(port) is int and 1 <= port <= 65535), "TCP 端口应为 1–65535")
                v.update(address=host_address(item.get("address")), port=port)
                for field in ("quotaGiB", "usedGiB"):
                    v[field] = None if item.get(field) is None else number(item[field], field, 1e8)
                unlimited = item.get("unlimited", False)
                check(type(unlimited) is bool, "不限额选项无效")
                if unlimited:
                    check(v["quotaGiB"] is None, "不限额节点不能同时设置流量上限")
                    v["unlimited"] = True
            elif group == "links":
                a, b, mode, observer = (item.get(f) for f in ("from", "to", "mode", "observer"))
                nodes = groups["nodes"]
                check(
                    isinstance(a, str) and isinstance(b, str) and a in nodes and b in nodes and a != b,
                    f"链路「{v['name']}」需要两个有效且不同的节点",
                )
                choice(mode, (None, "ICMP", "TCP"), "测量方式")
                if mode:
                    check(
                        observer in (a, b) and nodes[observer]["kind"] == "agent",
                        f"链路「{v['name']}」需选择一端的主机探针",
                    )
                standalone = item.get("standalone")
                check("standalone" not in item or type(standalone) is bool, "独立测量选项无效")
                v.update(
                    {
                        "standalone": standalone,
                        "from": a,
                        "to": b,
                        "mode": mode,
                        "observer": observer if mode else None,
                        "service": word(item.get("service") or "连接", "线路类型", 64),
                    }
                )
            else:
                entry = item.get("entry")
                check(isinstance(entry, str) and entry in groups["nodes"], f"线路「{v['name']}」的入口不存在")
                tail, current, seen = [], entry, {entry}
                for link_id in items(item.get("tail"), "线路分段", 64):
                    link = groups["links"].get(link_id) if isinstance(link_id, str) else None
                    check(
                        link and link["from"] == current and link["to"] not in seen,
                        f"线路「{v['name']}」的分段需要首尾相接，且节点不能重复",
                    )
                    tail.append(link_id)
                    current = link["to"]
                    seen.add(current)
                check(type(item.get("test", False)) is bool, "全程测试选项无效")
                v.update(
                    entry=entry,
                    tail=tail,
                    test=item.get("test", False),
                    testSource=choice(item.get("testSource", "system"), ("system", "simulated"), "测试来源"),
                    testMode=choice(item.get("testMode", "http204"), ("http204", "tls"), "全程测量方式"),
                    testProxy=test_address(item.get("testProxy"), proxy=True),
                    testUrl=test_address(item.get("testUrl")),
                )
                if v["testMode"] == "tls" and v["testUrl"]:
                    check(urlsplit(v["testUrl"]).scheme == "https", "TLS 握手需要 HTTPS 目标")
        groups[group] = values
    referenced = {key for route in groups["routes"].values() for key in route["tail"]}
    for key, link in groups["links"].items():
        if link["standalone"] is None:
            link["standalone"] = key not in referenced
    return {k: list(v.values()) for k, v in groups.items()}


def distinct_route_tests(cfg):
    if not tasks.route_tests_enabled():
        return
    graph = tasks.mesh(cfg)
    bindings = {}
    for route in cfg["routes"]:
        if not (
            route["test"]
            and route["testSource"] == "system"
            and route.get("testProxy")
            and route.get("testUrl")
        ):
            continue
        listener = (route["testProxy"], route["testUrl"])
        path = tasks.path_key(route, graph)
        check(
            listener not in bindings or bindings[listener] == path,
            "两条不同路径使用了相同的测试代理和 204 地址，测试端无法区分，请分别绑定",
        )
        bindings[listener] = path


def connect(state):
    db = sqlite3.connect(state / "linkscope.sqlite3", timeout=8)
    db.row_factory = sqlite3.Row
    return db


def config(db):
    row = db.execute("SELECT rev,body FROM config WHERE id=1").fetchone()
    return row["rev"], json.loads(row["body"])


def init(state, seed):
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    (state / "tokens").mkdir(mode=0o700, exist_ok=True)
    with connect(state) as db:
        db.executescript("""
          PRAGMA page_size=2048;
          PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS config(id INTEGER PRIMARY KEY, rev INTEGER, body TEXT);
          CREATE TABLE IF NOT EXISTS samples(kind TEXT, id TEXT, at INTEGER, body TEXT, PRIMARY KEY(kind,id,at));
          CREATE INDEX IF NOT EXISTS samples_time ON samples(at);
          CREATE INDEX IF NOT EXISTS samples_kind_time ON samples(kind,at);
          CREATE TABLE IF NOT EXISTS latest(kind TEXT, id TEXT, at INTEGER, body TEXT, PRIMARY KEY(kind,id));
          CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, at INTEGER, digest TEXT);
          CREATE TABLE IF NOT EXISTS meter(id TEXT PRIMARY KEY, used REAL, tx INTEGER, rx INTEGER, boot INTEGER, nic TEXT);
          CREATE TABLE IF NOT EXISTS billing(id TEXT PRIMARY KEY, period INTEGER, tx INTEGER NOT NULL, rx INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS task_history(kind TEXT,id TEXT,version INTEGER,closed INTEGER,body TEXT,PRIMARY KEY(kind,id,version));
          CREATE TABLE IF NOT EXISTS route_bindings(id TEXT,path TEXT,proxy TEXT,PRIMARY KEY(id,path));
          CREATE TABLE IF NOT EXISTS events(at INTEGER, kind TEXT, id TEXT, text TEXT, tone TEXT);
          CREATE TABLE IF NOT EXISTS web_accounts(role TEXT PRIMARY KEY,salt BLOB NOT NULL,verifier BLOB NOT NULL);
          CREATE TABLE IF NOT EXISTS web_sessions(digest BLOB PRIMARY KEY,role TEXT NOT NULL,expires INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS privacy_key(id INTEGER PRIMARY KEY,secret BLOB NOT NULL);
          CREATE TABLE IF NOT EXISTS access_collectors(id TEXT PRIMARY KEY,routes TEXT NOT NULL);
        """)
        db.execute("BEGIN IMMEDIATE")
        db.execute("DELETE FROM latest WHERE kind='summary'")
        db.execute("INSERT OR IGNORE INTO privacy_key VALUES(1,randomblob(32))")
        if not db.execute("SELECT 1 FROM config").fetchone():
            cfg = validated_config(json.loads(Path(seed).read_text()) if seed else EMPTY)
            distinct_route_tests(cfg)
            db.execute("INSERT INTO config VALUES(1,1,?)", (json.dumps(cfg),))
            for n in cfg["nodes"]:
                db.execute(
                    "INSERT INTO meter(id,used) VALUES(?,?)",
                    (n["id"], n["usedGiB"] * GIB if n["usedGiB"] is not None else None),
                )
        revision, cfg = config(db)
        if db.execute("PRAGMA user_version").fetchone()[0] == 0:
            tasks.migrate(db, cfg, revision, now_ms())
            db.execute("PRAGMA user_version=1")
        ensure_tokens(state, cfg)


def ensure_tokens(state, cfg):
    for key in ["client", *(n["id"] for n in cfg["nodes"] if n["kind"] == "agent")]:
        path = state / "tokens" / key
        if not path.exists():
            with path.open("x") as f:
                path.chmod(0o600)
                f.write(secrets.token_urlsafe(32))


def write_sample(db, kind, key, at, body, *, historical=False):
    data = json.dumps(body, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if historical:
        result = db.execute("INSERT OR IGNORE INTO samples VALUES(?,?,?,?)", (kind, key, at, data))
        if not result.rowcount:
            existing = db.execute(
                "SELECT body FROM samples WHERE kind=? AND id=? AND at=?", (kind, key, at)
            ).fetchone()
            check(json.loads(existing[0]) == body, "该时间已有不同的历史测量", 409)
        return
    db.execute("INSERT OR REPLACE INTO samples VALUES(?,?,?,?)", (kind, key, at, data))
    if kind != "summary":
        db.execute(
            "INSERT INTO latest VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET at=excluded.at,body=excluded.body",
            (kind, key, at, data),
        )


def save_config(db, state, incoming):
    obj(incoming, "配置")
    cfg = validated_config(incoming)
    db.execute("BEGIN IMMEDIATE")
    rev, previous = config(db)
    check(rev == incoming.get("revision"), "配置已被其他页面修改，请重新载入后编辑", 409)
    old = {k: {v["id"]: v for v in rows} for k, rows in previous.items()}
    new = {k: {v["id"]: v for v in rows} for k, rows in cfg.items()}
    reset = items(incoming.get("resetUsage", []), "流量校准")
    for key, n in new["nodes"].items():
        before = old["nodes"].get(key, {})
        if not before or before["usedGiB"] != n["usedGiB"] or key in reset:
            used = n["usedGiB"]
            db.execute(
                "INSERT INTO meter(id,used) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET used=excluded.used",
                (key, None if used is None else used * GIB),
            )
            db.execute("DELETE FROM billing WHERE id=?", (key,))
        elif n.get("resetDay") != before.get("resetDay"):
            db.execute("UPDATE billing SET period=NULL WHERE id=?", (key,))
    confirmed = items(incoming.get("bindProxy", []), "线路测试代理")
    check(all(isinstance(key, str) and key in new["routes"] for key in confirmed), "测试代理绑定无效")
    tasks.revise(db, previous, cfg, rev + 1, now_ms(), confirmed)
    distinct_route_tests(cfg)
    retired = {
        rid
        for rid, r in old["routes"].items()
        if r["testSource"] == "system"
        and (rid not in new["routes"] or new["routes"][rid]["testSource"] != "system")
    }
    if retired:
        for collector, allowed in db.execute("SELECT id,routes FROM access_collectors").fetchall():
            scope = set(json.loads(allowed))
            if scope.intersection(retired):
                db.execute(
                    "UPDATE access_collectors SET routes=? WHERE id=?",
                    (json.dumps(sorted(scope - retired)), collector),
                )
                db.execute("DELETE FROM latest WHERE kind='access' AND id=?", (collector,))
    for key, before in old["nodes"].items():
        n = new["nodes"].get(key)
        if n and (n["kind"], n["source"]) == (before["kind"], before["source"]):
            continue
        if not n:
            db.execute("DELETE FROM samples WHERE kind IN ('host','host:system','host:simulated') AND id=?", (key,))
        else:
            # Keep real readings available while a probe is detached. Each reporting
            # source gets its own history when the node switches between real and simulated.
            old_source, new_source = before["source"] or "system", n["source"] or "system"
            if old_source != new_source:
                db.execute("UPDATE samples SET kind=? WHERE kind='host' AND id=?", ("host:" + old_source, key))
                db.execute("UPDATE samples SET kind='host' WHERE kind=? AND id=?", ("host:" + new_source, key))
        db.execute("DELETE FROM latest WHERE kind='host' AND id=?", (key,))
        db.execute("DELETE FROM events WHERE kind='host' AND id=?", (key,))
        db.execute("DELETE FROM receipts WHERE id=?", (key,))
        db.execute("UPDATE meter SET tx=NULL,rx=NULL WHERE id=?", (key,))
        if not n:
            db.execute("DELETE FROM meter WHERE id=?", (key,))
            db.execute("DELETE FROM billing WHERE id=?", (key,))
        if not n or before["kind"] == "agent":
            (state / "tokens" / key).unlink(missing_ok=True)
    ensure_tokens(state, cfg)
    db.execute("UPDATE config SET rev=?,body=? WHERE id=1", (rev + 1, json.dumps(cfg)))
    return rev + 1


def metric_values(data, fields, percent=()):
    obj(data, "采样")
    return {
        k: None if data.get(k) is None else number(data[k], k, 100 if k in percent else 1e18) for k in fields
    }


def host_sample(raw):
    data = metric_values(
        raw,
        ("cpu", "ram", "disk", "up", "down", "ramUsed", "diskUsed", "memoryGiB", "diskGiB"),
        ("cpu", "ram", "disk"),
    )
    for key in ("os", "processor", "arch", "nic", "version"):
        data[key] = word(raw.get(key), key) if raw.get(key) is not None else None
    for key in ("boot", "cores", "txBytes", "rxBytes"):
        value = raw.get(key)
        check(value is None or type(value) is int and 0 <= value < 2**63, f"{key} 无效")
        data[key] = value
    return data


def link_sample(raw, mode):
    vals = metric_values(
        raw, ("latency", "packetLoss", "failureRate", "forward", "reverse"), ("packetLoss", "failureRate")
    )
    check(mode == "TCP" or vals["failureRate"] is None, "仅 TCP 支持连接失败率")
    check(mode == "ICMP" or vals["packetLoss"] is None, "仅 ICMP 支持丢包率")
    if raw.get("tcpTimeout") is not None:
        value = raw["tcpTimeout"]
        check(mode == "TCP" and type(value) in (int, float) and value in (0, 100), "TCP 超时结果无效")
        vals["tcpTimeout"] = value
    check(mode is not None or vals["latency"] is None, "该分段未配置延迟测试")
    return vals


def sessions_sample(raw, routes):
    sessions, seen = [], set()
    for s in items(raw, "客户端记录"):
        obj(s, "客户端")
        try:
            ip = str(ipaddress.ip_address(s["ip"]))
            check("%" not in ip, "来源 IP 无效")
        except (KeyError, ValueError, TypeError):
            raise Invalid("来源 IP 无效")
        entry = word(s.get("entry"), "接入节点")
        check((ip, entry) not in seen, "客户端接入记录重复")
        seen.add((ip, entry))
        mode = choice(s.get("mode"), (None, "ICMP", "TCP"), "接入测量方式")
        traffic = {}
        for rid, rates in obj(s.get("traffic"), "分线路速率").items():
            check(rid in routes and routes[rid]["entry"] == entry, "接入记录与线路入口不符")
            traffic[rid] = None if rates is None else metric_values(rates, ("forward", "reverse"))
        check(traffic, "接入记录缺少线路")
        sessions.append(
            dict(
                ip=ip,
                entry=entry,
                place=word(s.get("place") or "地区未知", "地区"),
                provider=word(s.get("provider") or "运营商未知", "运营商"),
                mode=mode,
                traffic=traffic,
                **link_sample(s, mode),
            )
        )
    return sessions


def billing_period(at, day):
    if day is None:
        return None
    date = datetime.fromtimestamp(at / 1000, timezone.utc)
    cutoff = min(day, calendar.monthrange(date.year, date.month)[1])
    return date.year * 12 + date.month - (date.day < cutoff)


def meter_update(db, n, h, at):
    last = db.execute("SELECT * FROM meter WHERE id=?", (n["id"],)).fetchone()
    tx, rx = h["txBytes"], h["rxBytes"]
    if tx is None or rx is None or not h["nic"] or not h["boot"]:
        return
    up = down = 0
    if last and last["tx"] is not None and h["nic"] == last["nic"]:
        same = h["boot"] == last["boot"]
        up = max(0, tx - last["tx"]) if same else tx
        down = max(0, rx - last["rx"]) if same else rx
    period = billing_period(at, n.get("resetDay"))
    previous = db.execute("SELECT period,tx,rx FROM billing WHERE id=?", (n["id"],)).fetchone()
    old_period, old_up, old_down = tuple(previous) if previous else (None, 0, 0)
    rollover = period is not None and old_period is not None and period != old_period
    if rollover:
        old_up = old_down = 0
    total_up, total_down = old_up + up, old_down + down
    delta = {
        "up": up,
        "down": down,
        "both": up + down,
        "max": max(total_up, total_down) - max(old_up, old_down),
    }[n["direction"]]
    db.execute(
        """INSERT INTO billing VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE
           SET period=excluded.period,tx=excluded.tx,rx=excluded.rx""",
        (n["id"], period, total_up, total_down),
    )
    db.execute(
        "UPDATE meter SET used=CASE WHEN ? THEN ? ELSE used+? END,tx=?,rx=?,boot=?,nic=? WHERE id=?",
        (rollover, delta, delta, tx, rx, h["boot"], h["nic"], n["id"]),
    )


def fault(s):
    return bool(s and ((s.get("packetLoss") or 0) > 0 or (s.get("failureRate") or 0) > 0))


def authenticate(state, token, reporter):
    reporter = word(reporter, "探针 ID", 40)
    check(re.fullmatch(r"(?:access\.)?[a-z][a-z0-9_-]*", reporter), "探针身份无效", 403)
    path = state / "tokens" / reporter
    check(
        token.isascii() and path.is_file() and secrets.compare_digest(token, path.read_text().strip()),
        "探针凭据无效",
        403,
    )


def authorize(db, cfg, reporter, source):
    choice(source, ("system", "simulated"), "上报来源")
    if reporter.startswith("access."):
        row = db.execute("SELECT routes FROM access_collectors WHERE id=?", (reporter,)).fetchone()
        check(row and source == "system", "接入采集端未获授权", 403)
        return set(json.loads(row[0]))
    if reporter == "client":
        return
    node = next((n for n in cfg["nodes"] if n["id"] == reporter), None)
    check(node and node["kind"] == "agent" and node["source"] == source, "节点未启用此来源的主机探针", 403)


def peer_id(ip, reporter):
    return f"peer-{reporter}-{ip}" if reporter.startswith("access.") else "peer-" + ip


def result_task(db, kind, key, raw, graph, reporter, source):
    if kind == "route":
        check(tasks.route_tests_enabled(), "整线测试已关闭，请重新领取任务", 409)
    obj(raw, "测量结果")
    group = "links" if kind == "link" else "routes"
    item = graph[group].get(key)
    version = raw.get("version")
    check(type(version) is int and version > 0, "缺少测量版本，请重新领取任务", 409)
    current = item is not None and version == item["version"]
    if current:
        task = tasks.definition(kind, item, graph)
    else:
        row = db.execute(
            "SELECT body FROM task_history WHERE kind=? AND id=? AND version=?", (kind, key, version)
        ).fetchone()
        check(row, "测量版本不存在，请重新领取任务", 409)
        task = json.loads(row["body"])
    check(task["observer"] == reporter and task["source"] == source, "该探针未获此次测量授权", 403)
    check(raw.get("observer") == reporter and raw.get("target") == task["target"], "测量方向与任务不符", 409)
    check(task.get("enabled", True), "线路未启用全程测试")
    return task, current


def ingest(db, state, token, report):
    obj(report, "上报")
    reporter = report.get("reporter")
    authenticate(state, token, reporter)
    db.execute("BEGIN IMMEDIATE")
    _, cfg = config(db)
    graph = tasks.mesh(cfg)
    source = report.get("source", "system")
    scope = authorize(db, cfg, reporter, source)
    if scope is not None:
        check(
            "sessions" in report and not any(k in report for k in ("host", "links", "routes")),
            "接入采集端只能提交自己的会话",
            403,
        )
    client = reporter == "client"
    receipt_id = "client@simulated" if client and source == "simulated" else reporter
    now = now_ms()
    at = report.get("at")
    check(type(at) is int and now - 300_000 <= at <= now + 2000, "采样时间需为最近五分钟的 Unix 毫秒")
    digest = hashlib.sha256(json.dumps(report, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    prior = db.execute("SELECT * FROM receipts WHERE id=?", (receipt_id,)).fetchone()
    if prior and at == prior["at"] and digest == prior["digest"]:
        return
    ordered = not prior or at > prior["at"]
    current_batch = "host" in report
    if current_batch:
        check(ordered, "时间戳已使用或早于最后一次上报", 409)
    check(any(k in report for k in ("host", "links", "routes", "sessions", "references")), "没有可写入的采样")
    if "references" in report:
        check(
            scope is None
            and not client
            and source == "system"
            and any(r["entry"] == reporter for r in cfg["routes"]),
            "只有本线路入口探针可上报地区反测",
            403,
        )
        check(ordered, "时间戳已使用或早于最后一次上报", 409)
        current_batch = True
        readings = obj(report["references"], "地区反测")
        fixed = tasks.fixed_ingresses()
        check(0 < len(readings) <= 12, "地区测点数量无效")
        for key, sample in readings.items():
            check(isinstance(key, str) and re.fullmatch(r"[a-z0-9-]{1,32}", key), "地区测点代号无效")
            obj(sample, "地区测点")
            mode = choice(sample.get("mode", "TCP"), ("TCP", "ICMP"), "地区反测方式")
            if fixed:
                target = fixed.get(key)
                check(
                    target
                    and mode == target["mode"]
                    and sample.get("region") == target["region"]
                    and sample.get("provider") == target["provider"],
                    "该地区测点未获派发",
                    409,
                )
            reading = link_sample(sample, mode)
            reading.update(
                mode=mode,
                region=word(sample.get("region"), "测点地区", 30),
                provider=word(sample.get("provider"), "测点运营商", 40),
            )
            series = reporter + "/" + key + ("-icmp" if mode == "ICMP" else "")
            write_sample(db, "reference", series, at, reading)
    if "host" in report:
        check(not client, "测试端不能代报主机指标", 403)
        h = host_sample(report["host"])
        meter_update(db, graph["nodes"][reporter], h, at)
        write_sample(db, "host", reporter, at, h)
    for key, raw in obj(report.get("links", {}), "分段").items():
        task, active = result_task(db, "link", key, raw, graph, reporter, source)
        s = link_sample(raw, task["mode"])
        s.update(version=task["version"], observer=reporter, target=task["target"])
        stored = tasks.series_id(key, task["version"])
        if not active:
            write_sample(db, "link", stored, at, s, historical=True)
            continue
        check(ordered, "时间戳已使用或早于最后一次上报", 409)
        current_batch = True
        old = db.execute("SELECT body FROM latest WHERE kind='link' AND id=?", (stored,)).fetchone()
        if (old or fault(s)) and fault(s) != fault(json.loads(old[0]) if old else None):
            db.execute(
                "INSERT INTO events VALUES(?,?,?,?,?)",
                (
                    at,
                    "link",
                    key,
                    ("出现丢包" if task["mode"] == "ICMP" else "出现建连失败") if fault(s) else "质量已恢复",
                    "amber" if fault(s) else "mint",
                ),
            )
        write_sample(db, "link", stored, at, s)
    if "routes" in report or "sessions" in report:
        check(client or scope is not None, "只有客户端可上报线路与接入记录", 403)
    for key, raw in obj(report.get("routes", {}), "线路").items():
        task, active = result_task(db, "route", key, raw, graph, reporter, source)
        check(ordered or not active, "时间戳已使用或早于最后一次上报", 409)
        current_batch |= active
        status = choice(raw.get("status"), ("ok", "timeout", "failed"), "请求结果")
        latency = number(raw.get("latency"), "全程延迟") if status == "ok" else None
        write_sample(
            db,
            "route",
            tasks.series_id(key, task["version"]),
            at,
            dict(
                status=status,
                latency=latency,
                source=source,
                version=task["version"],
                observer=reporter,
                target=task["target"],
            ),
            historical=not active,
        )
    if "sessions" in report:
        routes = {
            k: r
            for k, r in graph["routes"].items()
            if r["testSource"] == source and (scope is None or k in scope)
        }
        versions = obj(report.get("routeVersions"), "接入记录的线路版本")
        check(all(type(v) is int and v > 0 for v in versions.values()), "接入记录的线路版本无效")
        active_versions = {k: r["version"] for k, r in routes.items()}
        # Access reports replace a complete source snapshot. A stale empty snapshot must not clear a new one.
        sessions = sessions_sample(report["sessions"], routes) if versions == active_versions else []
        if versions == active_versions:
            check(ordered, "时间戳已使用或早于最后一次上报", 409)
            current_batch = True
            write_sample(
                db, "access", receipt_id, at, dict(sessions=sessions, source=source, routeVersions=versions)
            )
        for s in sessions:
            write_sample(
                db,
                "peer",
                peer_id(s["ip"], reporter) + "-" + s["entry"],
                at,
                {k: s[k] for k in ("latency", "packetLoss", "failureRate", "tcpTimeout") if k in s},
            )
    if current_batch:
        db.execute(
            "INSERT INTO receipts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,digest=excluded.digest",
            (receipt_id, at, digest),
        )
