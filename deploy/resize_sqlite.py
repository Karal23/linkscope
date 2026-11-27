"""Resize an offline Linkscope database, keeping a verified backup and WAL durability."""

import argparse
import os
import sqlite3
from contextlib import closing
from pathlib import Path
from tempfile import NamedTemporaryFile


def verify(db):
    result = db.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok":
        raise RuntimeError(result)


def resize(state, backup, page_size):
    if page_size not in (512, 1024, 2048, 4096, 8192, 16384, 32768, 65536):
        raise ValueError("不支持的 SQLite 页大小")
    path = (state / "linkscope.sqlite3").resolve()
    with closing(sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, timeout=2)) as db:
        original = db.execute("PRAGMA page_size").fetchone()[0]
        if original == page_size:
            return original
        db.execute("PRAGMA locking_mode=EXCLUSIVE")
        db.execute("BEGIN EXCLUSIVE")
        db.commit()
        with NamedTemporaryFile(dir=backup.parent) as tmp:
            with closing(sqlite3.connect(tmp.name)) as copy:
                db.backup(copy)
                verify(copy)
            os.link(tmp.name, backup)
        try:
            db.execute("PRAGMA journal_mode=DELETE").fetchone()
            db.execute(f"PRAGMA page_size={page_size}")
            db.execute("VACUUM")
            if db.execute("PRAGMA page_size").fetchone()[0] != page_size:
                raise RuntimeError("数据库页大小校验失败")
            verify(db)
        finally:
            if db.execute("PRAGMA journal_mode=WAL").fetchone()[0] != "wal":
                raise RuntimeError("恢复 WAL 模式失败")
    return original


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description="请先停止面板服务。备份使用新文件名。")
    cli.add_argument("--state", type=Path, required=True)
    cli.add_argument("--backup", type=Path, required=True)
    cli.add_argument("--page-size", type=int, default=2048)
    args = cli.parse_args()
    before = resize(args.state, args.backup, args.page_size)
    print(f"SQLite 页大小 {before} → {args.page_size} B")
