"""
SQLite (local) or PostgreSQL via DATABASE_URL (Neon free — data survives Render restarts).
"""

from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

import aiosqlite

DATABASE_URL = (os.environ.get("DATABASE_URL") or "").strip()
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql://" + DATABASE_URL[len("postgres://") :]

USE_PG = bool(DATABASE_URL)
_pool = None


def adapt_sql(sql: str) -> str:
    """? → $n for Postgres; fix a few SQLite-only bits."""
    if not USE_PG:
        return sql
    # nick lookups case-insensitive
    sql = sql.replace("nick = ? COLLATE NOCASE", "LOWER(nick) = LOWER(?)")
    sql = sql.replace("LIKE ? COLLATE NOCASE", "ILIKE ?")
    sql = sql.replace("COLLATE NOCASE", "")
    # INSERT OR IGNORE variants used in app
    if "INSERT OR IGNORE INTO contacts" in sql:
        sql = sql.replace("INSERT OR IGNORE INTO contacts", "INSERT INTO contacts")
        if "ON CONFLICT" not in sql.upper():
            sql = sql.rstrip().rstrip(";") + " ON CONFLICT (user_id, contact_id) DO NOTHING"
    elif "INSERT OR IGNORE INTO group_members" in sql:
        sql = sql.replace("INSERT OR IGNORE INTO group_members", "INSERT INTO group_members")
        if "ON CONFLICT" not in sql.upper():
            sql = sql.rstrip().rstrip(";") + " ON CONFLICT (group_id, user_id) DO NOTHING"
    elif "INSERT OR IGNORE INTO group_reads" in sql:
        sql = sql.replace("INSERT OR IGNORE INTO group_reads", "INSERT INTO group_reads")
        if "ON CONFLICT" not in sql.upper():
            sql = sql.rstrip().rstrip(";") + " ON CONFLICT (group_id, user_id) DO NOTHING"
    elif "INSERT OR IGNORE INTO media_files" in sql:
        sql = sql.replace("INSERT OR IGNORE INTO media_files", "INSERT INTO media_files")
        if "ON CONFLICT" not in sql.upper():
            sql = (
                sql.rstrip().rstrip(";")
                + " ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, content_type = EXCLUDED.content_type"
            )

    # group_reads upsert used in server
    if "ON CONFLICT(group_id, user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)" in sql:
        sql = sql.replace(
            "ON CONFLICT(group_id, user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)",
            "ON CONFLICT (group_id, user_id) DO UPDATE SET last_read_id = GREATEST(group_reads.last_read_id, EXCLUDED.last_read_id)",
        )

    n = 0

    def repl(_: re.Match) -> str:
        nonlocal n
        n += 1
        return f"${n}"

    return re.sub(r"\?", repl, sql)


async def init_pool() -> None:
    global _pool
    if USE_PG and _pool is None:
        import asyncpg

        _pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=8)


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


class _PgRow:
    __slots__ = ("_r",)

    def __init__(self, r):
        self._r = r

    def __getitem__(self, k):
        return self._r[k]


class Cursor:
    def __init__(self, rows=None, lastrowid=None, rowcount=0, aio_cur=None):
        self._rows = rows
        self._aio = aio_cur
        self.lastrowid = lastrowid
        self.rowcount = rowcount

    async def fetchone(self):
        if self._aio is not None:
            return await self._aio.fetchone()
        if not self._rows:
            return None
        return self._rows.pop(0)

    async def fetchall(self):
        if self._aio is not None:
            return await self._aio.fetchall()
        rows = self._rows or []
        self._rows = []
        return rows


class Conn:
    def __init__(self, raw, pg: bool):
        self.raw = raw
        self.pg = pg
        self.row_factory = None

    async def execute(self, sql: str, params: tuple | list | None = None) -> Cursor:
        params = tuple(params or ())
        if not self.pg:
            if self.row_factory is not None:
                self.raw.row_factory = self.row_factory
            cur = await self.raw.execute(sql, params)
            return Cursor(aio_cur=cur, lastrowid=cur.lastrowid, rowcount=cur.rowcount or 0)

        import asyncpg

        sql_pg = adapt_sql(sql)
        upper = sql_pg.strip().upper()
        is_insert = upper.startswith("INSERT")
        wants_id = is_insert and any(
            x in sql_pg
            for x in ("INTO users", "INTO messages", "INTO chat_groups", "into users", "into messages", "into chat_groups")
        )
        if wants_id and "RETURNING" not in upper:
            sql_pg = sql_pg.rstrip().rstrip(";") + " RETURNING id"

        try:
            if "RETURNING ID" in sql_pg.upper():
                row = await self.raw.fetchrow(sql_pg, *params)
                lid = int(row["id"]) if row else None
                return Cursor(lastrowid=lid, rowcount=1 if row else 0)
            if upper.startswith("SELECT") or upper.startswith("WITH"):
                rows = await self.raw.fetch(sql_pg, *params)
                return Cursor(rows=[_PgRow(r) for r in rows], rowcount=len(rows))
            status = await self.raw.execute(sql_pg, *params)
            rc = 0
            if status:
                parts = status.split()
                try:
                    rc = int(parts[-1])
                except ValueError:
                    rc = 0
            return Cursor(rowcount=rc)
        except asyncpg.UniqueViolationError:
            return Cursor(rowcount=0)

    async def executescript(self, script: str) -> None:
        if self.pg:
            for part in script.split(";"):
                part = part.strip()
                if not part or part.upper().startswith("PRAGMA"):
                    continue
                await self.raw.execute(part)
        else:
            await self.raw.executescript(script)

    async def commit(self) -> None:
        if not self.pg:
            await self.raw.commit()


@asynccontextmanager
async def connect(db_path: Path | None = None) -> AsyncIterator[Conn]:
    if USE_PG:
        if _pool is None:
            await init_pool()
        async with _pool.acquire() as raw:
            yield Conn(raw, True)
    else:
        async with aiosqlite.connect(str(db_path)) as raw:
            yield Conn(raw, False)


SCHEMA_SQLITE = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nick TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    avatar TEXT,
    created_at REAL NOT NULL,
    last_seen REAL
);
CREATE TABLE IF NOT EXISTS contacts (
    user_id INTEGER NOT NULL,
    contact_id INTEGER NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (user_id, contact_id)
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER,
    text TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    read_at REAL,
    group_id INTEGER,
    msg_type TEXT NOT NULL DEFAULT 'text',
    media_url TEXT,
    duration REAL
);
CREATE TABLE IF NOT EXISTS chat_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at REAL NOT NULL,
    PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS group_reads (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS media_files (
    id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL,
    data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender_id, receiver_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_receiver ON messages(receiver_id, read_at);
CREATE INDEX IF NOT EXISTS idx_msg_group ON messages(group_id, created_at);
"""

SCHEMA_PG = """
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    nick TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    avatar TEXT,
    created_at DOUBLE PRECISION NOT NULL,
    last_seen DOUBLE PRECISION
);
CREATE UNIQUE INDEX IF NOT EXISTS users_nick_lower ON users (LOWER(nick));
CREATE TABLE IF NOT EXISTS contacts (
    user_id INTEGER NOT NULL,
    contact_id INTEGER NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (user_id, contact_id)
);
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER,
    text TEXT NOT NULL DEFAULT '',
    created_at DOUBLE PRECISION NOT NULL,
    read_at DOUBLE PRECISION,
    group_id INTEGER,
    msg_type TEXT NOT NULL DEFAULT 'text',
    media_url TEXT,
    duration DOUBLE PRECISION
);
CREATE TABLE IF NOT EXISTS chat_groups (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS group_reads (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS media_files (
    id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL,
    data BYTEA NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender_id, receiver_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_receiver ON messages(receiver_id, read_at);
CREATE INDEX IF NOT EXISTS idx_msg_group ON messages(group_id, created_at);
"""


async def init_schema(db_path: Path | None = None) -> None:
    async with connect(db_path) as db:
        await db.executescript(SCHEMA_PG if USE_PG else SCHEMA_SQLITE)
        if not USE_PG:
            cur = await db.execute("PRAGMA table_info(messages)")
            cols = {r[1] for r in await cur.fetchall()}
            for col, ddl in [
                ("group_id", "ALTER TABLE messages ADD COLUMN group_id INTEGER"),
                ("msg_type", "ALTER TABLE messages ADD COLUMN msg_type TEXT DEFAULT 'text'"),
                ("media_url", "ALTER TABLE messages ADD COLUMN media_url TEXT"),
                ("duration", "ALTER TABLE messages ADD COLUMN duration REAL"),
            ]:
                if col not in cols:
                    try:
                        await db.execute(ddl)
                    except Exception:
                        pass
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS media_files (
                    id TEXT PRIMARY KEY,
                    content_type TEXT NOT NULL,
                    data BLOB NOT NULL
                )
                """
            )
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS push_subscriptions (
                    endpoint TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    p256dh TEXT NOT NULL,
                    auth TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
                """
            )
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS app_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)"
            )
            await db.commit()


async def save_media(media_id: str, content_type: str, data: bytes, db_path: Path | None = None) -> None:
    async with connect(db_path) as db:
        if USE_PG:
            await db.execute(
                "INSERT INTO media_files (id, content_type, data) VALUES (?, ?, ?) "
                "ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, content_type = EXCLUDED.content_type",
                (media_id, content_type, data),
            )
        else:
            await db.execute(
                "INSERT OR IGNORE INTO media_files (id, content_type, data) VALUES (?, ?, ?)",
                (media_id, content_type, data),
            )
            await db.execute(
                "UPDATE media_files SET content_type = ?, data = ? WHERE id = ?",
                (content_type, data, media_id),
            )
            await db.commit()


async def load_media(media_id: str, db_path: Path | None = None) -> tuple[bytes, str] | None:
    async with connect(db_path) as db:
        if not USE_PG:
            db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT data, content_type FROM media_files WHERE id = ?", (media_id,)
        )
        row = await cur.fetchone()
        if not row:
            return None
        return bytes(row["data"] if not isinstance(row["data"], memoryview) else bytes(row["data"])), row["content_type"]
