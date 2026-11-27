"""Dashboard credentials for the HTTPS deployment. Provision accounts on the server."""

import argparse
import getpass
import hashlib
import hmac
import secrets
import threading
from contextlib import closing
from http.cookies import CookieError, SimpleCookie
from pathlib import Path

from store import Invalid, check, connect, init, now_ms

ROLES = ("admin", "viewer")
COOKIE = "__Host-linkscope"
SESSION_SECONDS = 12 * 3600
PASSWORD_JOBS = threading.BoundedSemaphore(2)


def derive(password, salt):
    return hashlib.scrypt(password.encode(), salt=salt, n=2**15, r=8, p=3, maxmem=64 * 1024**2)


def set_password(db, role, password):
    check(
        role in ROLES and isinstance(password, str) and 12 <= len(password) <= 128, "密码长度应为 12–128 位"
    )
    salt = secrets.token_bytes(16)
    verifier = derive(password, salt)
    db.execute("INSERT OR REPLACE INTO web_accounts VALUES(?,?,?)", (role, salt, verifier))
    db.execute("DELETE FROM web_sessions WHERE role=?", (role,))


def login(db, data):
    role, password = data.get("role"), data.get("password")
    check(role in ROLES and isinstance(password, str) and 0 < len(password) <= 128, "账号或密码错误", 401)
    check(PASSWORD_JOBS.acquire(blocking=False), "登录请求较多，请稍后再试", 429)
    try:
        row = db.execute("SELECT salt,verifier FROM web_accounts WHERE role=?", (role,)).fetchone()
        try:
            proof = derive(password, row["salt"] if row else bytes(16))
        except UnicodeEncodeError:
            raise Invalid("账号或密码错误", 401)
        check(row and hmac.compare_digest(proof, row["verifier"]), "账号或密码错误", 401)
    finally:
        PASSWORD_JOBS.release()
    token = secrets.token_urlsafe(32)
    now = now_ms()
    db.execute("DELETE FROM web_sessions WHERE expires<=?", (now,))
    # A password reset between verification and insertion also invalidates this login.
    result = db.execute(
        "INSERT INTO web_sessions SELECT ?,role,? FROM web_accounts WHERE role=? AND verifier=?",
        (hashlib.sha256(token.encode()).digest(), now + SESSION_SECONDS * 1000, role, proof),
    )
    check(result.rowcount == 1, "请重新登录", 401)
    return token


def session(db, cookie):
    jar = SimpleCookie()
    try:
        jar.load(cookie)
    except CookieError:
        return None, None
    item = jar.get(COOKIE)
    if not item or len(item.value) != 43 or not item.value.isascii():
        return None, None
    digest = hashlib.sha256(item.value.encode()).digest()
    row = db.execute(
        "SELECT role FROM web_sessions WHERE digest=? AND expires>?", (digest, now_ms())
    ).fetchone()
    return (row["role"], digest) if row else (None, None)


def cookie_header(token, age):
    return ("Set-Cookie", f"{COOKIE}={token}; Path=/; Max-Age={age}; Secure; HttpOnly; SameSite=Strict")


def main():
    p = argparse.ArgumentParser(description="设置或重置公网面板的登录密码")
    p.add_argument("role", choices=ROLES)
    p.add_argument("--state", type=Path, required=True)
    args = p.parse_args()
    first = getpass.getpass("新密码（12–128 位） ")
    if first != getpass.getpass("再输入一次 "):
        p.exit(1, "两次输入不同\n")
    try:
        init(args.state, None)
        with closing(connect(args.state)) as db, db:
            set_password(db, args.role, first)
    except Invalid as err:
        p.exit(1, f"{err}\n")
    print(f"已更新 {args.role} 密码，此账户须重新登录。")


if __name__ == "__main__":
    main()
