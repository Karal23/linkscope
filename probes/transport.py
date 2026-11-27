import http.client
import ipaddress
import json
import os
import ssl
import sys
import threading
import time
from functools import lru_cache
from urllib.parse import urlencode, urlsplit
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener, getproxies, proxy_bypass


class NoControlRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_session = threading.local()


@lru_cache(maxsize=1)
def tls_context():
    context = ssl.create_default_context()
    context.set_alpn_protocols(["http/1.1"])
    return context


@lru_cache(maxsize=1)
def system_proxy_opener():
    return build_opener(NoControlRedirect(), HTTPSHandler(context=tls_context()))


def control_url(url):
    parsed = urlsplit(url)
    host = parsed.hostname
    try:
        local = ipaddress.ip_address(host or "").is_loopback
    except ValueError:
        local = host == "localhost"
    if (
        not host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not (parsed.scheme == "https" or (parsed.scheme == "http" and local))
    ):
        raise ValueError("远程上报地址需要 HTTPS，本机回环支持 HTTP")
    return url.rstrip("/")


@lru_cache(maxsize=1)
def control_proxy(url):
    from urllib3.contrib.socks import SOCKSProxyManager

    return SOCKSProxyManager(url, cert_reqs="CERT_REQUIRED")


def direct_request(request):
    origin = (request.type, request.host)
    if getattr(_session, "origin", None) != origin:
        if hasattr(_session, "connection"):
            _session.connection.close()
        _session.connection = (
            http.client.HTTPSConnection(request.host, timeout=5, context=tls_context())
            if request.type == "https"
            else http.client.HTTPConnection(request.host, timeout=5)
        )
        _session.origin = origin
    connection = _session.connection
    for attempt in range(2):
        reused = connection.sock is not None
        try:
            connection.request(
                request.get_method(), request.selector, body=request.data, headers=dict(request.header_items())
            )
            with connection.getresponse() as response:
                data = response.read()
        except (OSError, http.client.HTTPException) as exc:
            connection.close()
            # A server can close an idle connection just before the next request.
            # Report retries use identical bytes and the server deduplicates their receipt.
            stale = isinstance(exc, (ConnectionError, http.client.IncompleteRead, ssl.SSLEOFError))
            if attempt == 0 and reused and stale:
                continue
            raise URLError(exc) from exc
        if response.status != 200:
            raise HTTPError(request.full_url, response.status, "面板请求失败", response.headers, None)
        return json.loads(data)


def read_control(request):
    request.add_header("User-Agent", "linkscope-agent/2")
    proxy = os.environ.get("LINKSCOPE_CONTROL_PROXY")
    if proxy and request.type == "https":
        try:
            from urllib3.exceptions import HTTPError as ProxyError

            manager = control_proxy(proxy)
        except ImportError as exc:
            raise ValueError("SOCKS 上报需要安装 urllib3 和 PySocks") from exc
        try:
            response = manager.request(
                request.get_method(),
                request.full_url,
                body=request.data,
                headers=dict(request.header_items()),
                timeout=5,
                redirect=False,
                retries=False,
            )
        except ProxyError as exc:
            raise URLError("通过控制代理连接面板失败") from exc
        if response.status != 200:
            raise HTTPError(request.full_url, response.status, "面板请求失败", response.headers, None)
        return json.loads(response.data)
    if getproxies().get(request.type) and not proxy_bypass(request.host):
        with system_proxy_opener().open(request, timeout=5) as result:
            return json.load(result)
    return direct_request(request)


def get_tasks(url, token, reporter, source="system", *, known=None):
    params = {"reporter": reporter, "source": source}
    if known:
        params["known"] = known
    request = Request(
        control_url(url) + "/api/v1/tasks?" + urlencode(params), headers={"Authorization": "Bearer " + token}
    )
    return read_control(request)


def task_result(task, reading):
    return {**reading, **{key: task[key] for key in ("version", "observer", "target")}}


def post(url, token, report, *, want_tasks=False, known=None):
    query = ""
    if want_tasks:
        query = "?tasks=1" + ("&" + urlencode({"known": known}) if known else "")
    request = Request(
        control_url(url) + "/api/v1/reports" + query,
        data=json.dumps(report, allow_nan=False).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    return read_control(request)


def run_periodically(job, interval):
    while True:
        start = time.monotonic()
        try:
            job()
        except (HTTPError, URLError, OSError, ValueError) as e:
            print(f"上报未完成 {e}", file=sys.stderr, flush=True)
        time.sleep(max(0.1, interval - (time.monotonic() - start)))
