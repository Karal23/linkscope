import argparse
import hashlib
import json
import mimetypes
import re
import sqlite3
import threading
from contextlib import closing
from http import HTTPStatus
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, urlsplit
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

import accounts
import tasks
from dashboard import (
    LATENCY_KINDS, history, host_averages, latency_bars, record_summaries, resolve_viewer_peer, snapshot,
)
from store import (
    Invalid,
    authenticate,
    authorize,
    check,
    config,
    connect,
    host_address,
    ingest,
    init,
    now_ms,
    obj,
    save_config,
)

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "dist"
MAX_BODY = 256_000
HISTORY_SLOT = 60_000
HISTORY_HOT = 600_000
HISTORY_HOT_LIMIT = 128
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; "
    "base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'"
)


def body(env, limit=MAX_BODY):
    check(
        env.get("CONTENT_TYPE", "").split(";")[0].strip().lower() == "application/json", "需要 JSON 请求", 415
    )
    size = env.get("CONTENT_LENGTH", "")
    check(
        size.isascii() and size.isdecimal() and len(size) < 8 and 0 < int(size) <= limit, "请求大小无效", 413
    )
    try:
        data = json.loads(env["wsgi.input"].read(int(size)))
    except (ValueError, UnicodeError, RecursionError):
        raise Invalid("JSON 格式无效")
    return obj(data, "请求")


def reply(status, data, headers=(), mime="application/json; charset=utf-8"):
    if not isinstance(data, bytes):
        data = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    return (
        status,
        [
            ("Content-Type", mime),
            ("Content-Length", str(len(data))),
            ("Cache-Control", "private, max-age=86400" if mime.startswith("font/") else "no-store"),
            ("X-Content-Type-Options", "nosniff"),
            ("X-Frame-Options", "DENY"),
            ("Referrer-Policy", "no-referrer"),
            ("Content-Security-Policy", CSP),
            *headers,
        ],
        data,
    )


def public_authority(origin):
    u = urlsplit(origin)
    check(
        u.scheme == "https"
        and u.hostname
        and u.username is None
        and u.password is None
        and u.path in ("", "/")
        and "?" not in origin
        and "#" not in origin
        and u.netloc.isascii()
        and not any(c.isspace() for c in origin)
        and (u.port is None or u.port > 0),
        "公网地址需为完整的 HTTPS 来源，例如 https://monitor.example.com",
    )
    host = host_address(u.hostname)
    authority = f"[{host}]" if ":" in host else host
    return f"{authority}:{u.port}" if u.port not in (None, 443) else authority


def bearer(env):
    value = env.get("HTTP_AUTHORIZATION", "")
    check(value.startswith("Bearer ") and len(value) <= 256, "需要探针凭据", 401)
    return value[7:]


def task_plan(db, reporter, source, known=""):
    revision, cfg = config(db)
    scope = authorize(db, cfg, reporter, source)
    plan = tasks.assignments(cfg, reporter, source) if scope is None else {"links": {}, "routes": {}}
    if reporter == "client" or scope is not None:
        plan["profiles"] = {
            r["id"]: dict(version=r["version"], entry=r["entry"], direct=not r["tail"])
            for r in cfg["routes"]
            if r["testSource"] == source and (scope is None or r["id"] in scope)
        }
    plan["revision"] = revision
    # Grants and fixed reference targets can change without a topology revision.
    encoded = json.dumps(plan, sort_keys=True, separators=(",", ":")).encode()
    tag = hashlib.blake2s(encoded, digest_size=12).hexdigest()
    if known == tag:
        return {"unchanged": True}
    return {**plan, "planTag": tag}


def config_revision(db):
    return db.execute("SELECT rev FROM config WHERE id=1").fetchone()[0]


class HistoryCache:
    """Detail history computed once per series and minute, then shared.

    Every viewer, refresh and reopened panel in the same minute gets one result. A live series asked
    for in the last ten minutes is computed again in the background as each minute starts, and a
    request that arrives before that finishes gets the previous minute instead of waiting for it.
    """

    def __init__(self, state):
        self.state = state
        self.guard = threading.Lock()
        self.results = {}
        self.flights = {}
        self.hot = {}
        self.queued = set()

    @staticmethod
    def minute(end):
        # Rounding up keeps the newest reports inside the window and aligns bars to whole minutes.
        return -(-end // HISTORY_SLOT) * HISTORY_SLOT

    def get(self, db, series, end, compute):
        now = now_ms()
        live = end >= now - HISTORY_SLOT
        end = self.minute(min(end, now))
        with self.guard:
            hit = self.results.get((series, end))
            if live and (series in self.hot or len(self.hot) < HISTORY_HOT_LIMIT):
                self.hot[series] = (now, compute)
                previous = self.results.get((series, end - HISTORY_SLOT))
                if hit is None and previous is not None:
                    self.queued.add((series, end))
                    return previous
        return hit if hit is not None else self.compute(db, series, end, compute)

    def compute(self, db, series, end, compute):
        with self.guard:
            flight = self.flights.setdefault((series, end), threading.Lock())
        with flight:
            with self.guard:
                hit = self.results.get((series, end))
            if hit is None:
                try:
                    hit = compute(db, end)
                    with self.guard:
                        self.results[(series, end)] = hit
                        if len(self.results) > 1000:
                            for old in list(self.results)[:500]:
                                del self.results[old]
                finally:
                    with self.guard:
                        self.flights.pop((series, end), None)
        return hit

    def warm_once(self, db):
        now = now_ms()
        end = self.minute(now)
        revision = config_revision(db)
        with self.guard:
            for series, (seen, _) in list(self.hot.items()):
                if now - seen > HISTORY_HOT or series[0] != revision:
                    del self.hot[series]
            computes = {series: compute for series, (_, compute) in self.hot.items()}
            jobs = {(series, end) for series in computes} | self.queued
            self.queued = set()
        for series, at in sorted(jobs, key=lambda job: job[1]):
            if series in computes:
                self.compute(db, series, at, computes[series])

    def warm(self, stopped):
        with closing(connect(self.state)) as db:
            while not stopped.is_set():
                try:
                    self.warm_once(db)
                except sqlite3.Error as err:
                    print(f"历史预热失败，下一轮重试 {err}", flush=True)
                stopped.wait(2)


class Application:
    def __init__(self, state, hosts, origin=None):
        self.state = state
        self.histories = HistoryCache(state)
        self.hosts = hosts
        self.origin = origin
        self.files = {"/" + f.relative_to(ASSETS).as_posix(): f for f in ASSETS.rglob("*") if f.is_file()}
        self.files.update(
            {
                "/": ASSETS / "index.html",
                "/admin": ASSETS / "admin.html",
                "/admin/": ASSETS / "admin.html",
                "/login": ASSETS / "login.html",
            }
        )
        with closing(connect(state)) as db:
            self.viewer_key = db.execute("SELECT secret FROM privacy_key WHERE id=1").fetchone()[0]
            protected = db.execute("SELECT 1 FROM web_accounts WHERE role='admin'").fetchone()
            any_account = db.execute("SELECT 1 FROM web_accounts LIMIT 1").fetchone()
        if origin and not protected:
            raise ValueError("先使用 backend/accounts.py 为 admin 设置密码")
        if not origin and any_account:
            raise ValueError("此状态目录已启用登录，请指定 --public-origin")

    def __call__(self, env, start_response):
        try:
            status, headers, data = self.request(env)
        except Invalid as e:
            status, headers, data = reply(e.status, {"error": str(e)})
        start_response(f"{status} {HTTPStatus(status).phrase}", headers)
        return [data]

    def request(self, env):
        host = env.get("HTTP_HOST", "").lower()
        if self.origin:
            host = host.removesuffix(":443")
        check(host in self.hosts, "站点地址不匹配", 403)
        origin = self.origin or "http://" + host
        if not self.origin:
            check(
                not any(
                    env.get(k)
                    for k in (
                        "HTTP_FORWARDED",
                        "HTTP_X_FORWARDED_FOR",
                        "HTTP_X_FORWARDED_PROTO",
                        "HTTP_X_FORWARDED_HOST",
                    )
                ),
                "远程访问请使用公网模式",
                403,
            )
        method, path = env["REQUEST_METHOD"], env["PATH_INFO"]
        check(method in ("GET", "POST", "PUT"), "不支持此请求方法", 405)
        try:
            query = parse_qs(env.get("QUERY_STRING", ""), max_num_fields=12)
        except ValueError:
            raise Invalid("查询参数无效")

        def param(key, default=""):
            return query.get(key, [default])[0]

        def same_origin():
            check(env.get("HTTP_ORIGIN") == origin, "请求来源不匹配", 403)

        if method == "GET" and not path.startswith("/api/"):
            file = self.files.get(path)
            check(file, "找不到页面", 404)
            if file.name == "login.html" and not self.origin:
                return reply(303, b"", [("Location", "/")])
            if self.origin and file.name == "admin.html":
                with closing(connect(self.state)) as db:
                    role, _ = accounts.session(db, env.get("HTTP_COOKIE", ""))
                if not role:
                    return reply(303, b"", [("Location", "/login?next=admin")])
                check(role == "admin", "需要管理员权限", 403)
            return reply(
                200, file.read_bytes(), mime=mimetypes.guess_type(str(file))[0] or "application/octet-stream"
            )

        with closing(connect(self.state)) as db, db:
            if not self.origin:
                check(
                    not db.execute("SELECT 1 FROM web_accounts LIMIT 1").fetchone(),
                    "此目录已启用登录，请以公网模式重启服务",
                    503,
                )
            if (method, path) == ("GET", "/api/v1/tasks"):
                token = bearer(env)
                reporter, source = param("reporter"), param("source", "system")
                check(not self.origin or source == "system", "公网服务仅接受实际探针", 403)
                authenticate(self.state, token, reporter)
                db.execute("BEGIN")
                return reply(200, task_plan(db, reporter, source, param("known")))
            if (method, path) == ("POST", "/api/v1/reports"):
                token = bearer(env)
                data = body(env)
                check(
                    not self.origin or data.get("source", "system") == "system", "公网服务仅接受实际探针", 403
                )
                ingest(db, self.state, token, data)
                if "host" in data and param("tasks") == "1":
                    plan = task_plan(db, data["reporter"], data.get("source", "system"), param("known"))
                    return reply(200, {"accepted": True, "tasks": plan})
                return reply(200, {"accepted": True})

            if self.origin and (method, path) == ("POST", "/api/v1/login"):
                same_origin()
                token = accounts.login(db, body(env, 2048))
                return reply(200, {"ok": True}, [accounts.cookie_header(token, accounts.SESSION_SECONDS)])
            role, digest = (
                accounts.session(db, env.get("HTTP_COOKIE", "")) if self.origin else ("local", None)
            )
            if self.origin and (method, path) == ("POST", "/api/v1/logout"):
                check(role, "请先登录", 401)
                same_origin()
                db.execute("DELETE FROM web_sessions WHERE digest=?", (digest,))
                return reply(200, {"ok": True}, [accounts.cookie_header("", 0)])
            if path == "/api/v1/config":
                check(role, "请先登录管理员账号", 401)
                check(role in ("local", "admin"), "需要管理员权限", 403)
                if method == "PUT":
                    same_origin()
                    check(env.get("HTTP_X_LINKSCOPE_ADMIN") == "1", "请从管理页面保存", 403)
                    save_config(db, self.state, body(env))
                else:
                    check(method == "GET", "不支持此请求方法", 405)
                    db.execute("BEGIN")
                revision, cfg = config(db)
                return reply(
                    200,
                    {
                        **cfg,
                        "revision": revision,
                        "routeTestsEnabled": tasks.route_tests_enabled(),
                        "usage": {
                            r["id"]: None if r["used"] is None else r["used"] / 1024**3
                            for r in db.execute("SELECT id,used FROM meter")
                        },
                    },
                    [("X-Linkscope-Access", role)],
                )
            check(method == "GET", "找不到接口", 404)
            role = role or "viewer"
            db.execute("BEGIN")
            if path == "/api/v1/state":
                payload = snapshot(db, viewer_key=self.viewer_key if role == "viewer" else None)
                payload["accessRole"] = role
                payload["signedIn"] = digest is not None
                summaries = payload["summaries"]
                scope = param("trend")
                # Existing API consumers can still request every trend by omitting the scope.
                scopes = [scope if scope in summaries else "all"] if scope else summaries
                payload["trends"] = {
                    k: history(db, "summary", k, payload["now"], 3_600_000, 22, summaries[k].get("version"))
                    for k in scopes
                }
                return reply(200, payload)
            kind, key = param("kind"), param("id")
            if path == "/api/v1/versions":
                check(kind in ("route", "link") and 0 < len(key) <= 40, "版本查询参数无效")
                return reply(200, tasks.versions(db, kind, key, config(db)[1]))
            if path == "/api/v1/history":
                span, end, version = (
                    param("minutes", "5"),
                    param("end", str(now_ms())),
                    param("version", None),
                )
                check(
                    version is None
                    or (
                        version.isascii()
                        and version.isdecimal()
                        and len(version) < 16
                        and kind in ("link", "route", "summary")
                    ),
                    "历史版本无效",
                )
                check(
                    kind in ("host", "link", "peer", "route", "reference", "summary")
                    and 0 < len(key) <= 160
                    and span in ("5", "60", "1440")
                    and end.isascii()
                    and end.isdecimal()
                    and len(end) <= 13,
                    "历史查询参数无效",
                )
                if role == "viewer" and kind == "peer":
                    key = resolve_viewer_peer(db, key, self.viewer_key)
                    check(key, "找不到接入记录", 404)
                if param("resolution") == "averages":
                    check(kind == "host" and span == "1440", "主机均值查询参数无效")

                    def averages(db, at):
                        return host_averages(db, key, at)

                    series = (config_revision(db), "averages", key)
                    return reply(200, self.histories.get(db, series, int(end), averages))
                if param("resolution") == "bars":
                    carrier = param("carrier", None)
                    check(
                        kind in ("link", "peer", "reference", "route", "summary")
                        and (kind != "summary" or key != "all")
                        and (
                            carrier is None
                            or (kind == "summary" and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,120}", carrier))
                        ),
                        "历史柱状参数无效",
                    )
                    version_id = int(version) if version is not None else None
                    minutes = int(span)

                    def bars(db, at):
                        return latency_bars(db, kind, key, at, minutes, version_id, carrier)

                    if minutes == 5:
                        # Rounds are placed against the true end, so this view is neither rounded nor shared.
                        return reply(200, bars(db, min(int(end), now_ms())))
                    series = (config_revision(db), "bars", kind, key, minutes, version_id, carrier)
                    archive = param("archive", None)
                    if archive is not None:
                        owner = re.fullmatch(r"(route|link)/([a-z][a-z0-9_-]{0,39})/([0-9]{1,15})", archive)
                        check(owner, "历史归档参数无效")
                        owner_kind, owner_id, owner_version = owner.groups()
                        row = db.execute(
                            "SELECT closed FROM task_history WHERE kind=? AND id=? AND version=?",
                            (owner_kind, owner_id, int(owner_version)),
                        ).fetchone()
                        check(row, "此测量版本的历史已过期", 404)
                        cutoff = tasks.archive_end(db, owner_kind, owner_id, int(owner_version), row[0], int(end))
                        return reply(200, self.histories.compute(db, (*series, "archive"), cutoff, bars))
                    return reply(200, self.histories.get(db, series, int(end), bars))
                rate_metric = param("metric", None)
                check(
                    rate_metric is None
                    or (rate_metric == "tcpLoss" and kind in ("link", "peer"))
                    or (rate_metric == "loss" and kind == "reference"),
                    "历史比率指标无效",
                )
                count = {"5": 61, "60": 121, "1440": 289}[span]
                if kind == "summary" and span == "60" and param("resolution") == "trend":
                    count = 22
                return reply(
                    200,
                    history(
                        db,
                        kind,
                        key,
                        min(int(end), now_ms()),
                        int(span) * 60_000,
                        count,
                        int(version) if version is not None else None,
                        raw=param("resolution", "") == "samples"
                        and (span == "5" or (span == "60" and kind in LATENCY_KINDS)),
                        rate_metric=rate_metric,
                    ),
                )
            raise Invalid("找不到接口", 404)


class LocalServer(ThreadingMixIn, WSGIServer):
    daemon_threads = True


class QuietPreview(WSGIRequestHandler):
    def log_message(self, *args):
        pass


def serve(port, state, seed, origin=None):
    authority = public_authority(origin) if origin is not None else None
    init(state, seed)
    if authority:
        from waitress import create_server

        origin = "https://" + authority
        app = Application(state, {authority}, origin)
        server = create_server(
            app,
            host="127.0.0.1",
            port=port,
            threads=8,
            connection_limit=100,
            max_request_body_size=MAX_BODY,
            max_request_header_size=16384,
            channel_timeout=20,
            expose_tracebacks=False,
        )
        run = server.run
        close = server.close
        address = origin
    else:
        server = make_server("127.0.0.1", port, None, server_class=LocalServer, handler_class=QuietPreview)
        port = server.server_port
        app = Application(state, {f"localhost:{port}", f"127.0.0.1:{port}"})
        server.set_app(app)
        run = server.serve_forever
        close = server.server_close
        address = f"http://localhost:{port}"
    stopped = threading.Event()

    def rollup():
        previous = {}
        # Keep WAL open between reports so SQLite can checkpoint accumulated pages together.
        with closing(connect(state)) as db:
            while not stopped.is_set():
                try:
                    with db:
                        record_summaries(db, previous)
                except sqlite3.OperationalError as err:
                    print(f"汇总失败，下一轮重试 {err}", flush=True)
                stopped.wait(5)

    thread = threading.Thread(target=rollup, daemon=True)
    thread.start()
    warmer = threading.Thread(target=app.histories.warm, args=(stopped,), daemon=True)
    warmer.start()
    print(f"Linkscope {address}/", flush=True)
    try:
        run()
    except KeyboardInterrupt:
        pass
    finally:
        stopped.set()
        close()
        thread.join()
        warmer.join()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=4186)
    p.add_argument("--state", type=Path, default=ROOT / ".local-state")
    p.add_argument("--initial-config", type=Path)
    p.add_argument("--public-origin", help="浏览器访问的 HTTPS 来源，启用公网鉴权")
    args = p.parse_args()
    try:
        serve(args.port, args.state, args.initial_config, args.public_origin)
    except (ValueError, ImportError) as err:
        p.exit(1, f"启动失败 {err}\n")
