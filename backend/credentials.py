"""Provision scoped access collectors and rotate probe credentials on the panel host."""

import argparse
import json
import os
from pathlib import Path
import re
import secrets
from tempfile import NamedTemporaryFile
from contextlib import closing

from store import Invalid, check, config, connect, init


def collector_id(name):
    check(
        isinstance(name, str) and re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", name),
        "采集端名称需为小写字母、数字、短横线或下划线",
    )
    return "access." + name


def replace_token(path):
    with NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as f:
        try:
            f.write(secrets.token_urlsafe(32))
            f.flush()
            os.fsync(f.fileno())
            os.replace(f.name, path)
        finally:
            Path(f.name).unlink(missing_ok=True)


def manage(db, state, command, name, routes=()):
    db.execute("BEGIN IMMEDIATE")
    cfg = config(db)[1]
    if command == "rotate":
        reporters = {n["id"] for n in cfg["nodes"] if n["kind"] == "agent"}
        reporters.update(row[0] for row in db.execute("SELECT id FROM access_collectors"))
        check(name == "client" or name in reporters, "该探针不存在")
        key = name
    else:
        key = collector_id(name)
    token = state / "tokens" / key
    if command == "allow-access":
        available = {r["id"] for r in cfg["routes"] if r["testSource"] == "system"}
        check(routes and set(routes) <= available, "请选择已有的实际线路")
        db.execute(
            "INSERT OR REPLACE INTO access_collectors VALUES(?,?)", (key, json.dumps(sorted(set(routes))))
        )
        db.execute("DELETE FROM latest WHERE kind='access' AND id=?", (key,))
        if not token.exists():
            replace_token(token)
    elif command == "revoke-access":
        db.execute("DELETE FROM access_collectors WHERE id=?", (key,))
        db.execute("DELETE FROM latest WHERE kind='access' AND id=?", (key,))
        db.execute("DELETE FROM receipts WHERE id=?", (key,))
        token.unlink(missing_ok=True)
    else:
        replace_token(token)
    return token


def main():
    p = argparse.ArgumentParser(description="管理远端探针凭据")
    p.add_argument("--state", type=Path, required=True)
    sub = p.add_subparsers(dest="command", required=True)
    allow = sub.add_parser("allow-access", help="为独立接入采集端指定线路")
    allow.add_argument("name")
    allow.add_argument("--route", action="append", required=True)
    for action in ("revoke-access", "rotate"):
        sub.add_parser(action).add_argument("name")
    args = p.parse_args()
    try:
        init(args.state, None)
        with closing(connect(args.state)) as db, db:
            path = manage(db, args.state, args.command, args.name, getattr(args, "route", ()))
    except Invalid as err:
        p.exit(1, f"{err}\n")
    print("已撤销" if args.command == "revoke-access" else f"凭据文件 {path}")


if __name__ == "__main__":
    main()
