"""
Калаграм — multi-user messenger.
Run: python server.py
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import aiosqlite
import jwt
import uvicorn
from db import (
    USE_PG,
    close_pool,
    connect,
    init_pool,
    init_schema,
    load_media,
    save_media,
)
from push_service import (
    ensure_vapid_keys,
    ensure_vapid_keys_db,
    public_key as vapid_public_key,
    send_web_push,
)
from fastapi import (
    Cookie,
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Request,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from passlib.context import CryptContext
from pydantic import BaseModel, Field, field_validator

# ── paths & config ──────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent


def _is_cloud() -> bool:
    """True when running on PaaS (Render, Railway, Fly, …) — TLS terminates at proxy."""
    return any(
        os.environ.get(k)
        for k in (
            "RENDER",
            "RAILWAY_ENVIRONMENT",
            "FLY_APP_NAME",
            "K_SERVICE",
            "DYNO",
            "KOYEB_APP_ID",
            "SPACE_ID",
            "MESSENGER_CLOUD",
        )
    )


# DATA_DIR can point to a persistent volume on hosting
DATA = Path(os.environ.get("DATA_DIR", str(ROOT / "data"))).resolve()
AVATARS = DATA / "avatars"
VOICE = DATA / "voice"
DB_PATH = DATA / "messenger.db"
STATIC = ROOT / "static"

DATA.mkdir(parents=True, exist_ok=True)
AVATARS.mkdir(parents=True, exist_ok=True)
VOICE.mkdir(parents=True, exist_ok=True)

_secret = os.environ.get("MESSENGER_SECRET", "").strip()
if not _secret:
    # stable per-install secret stored in data/ (survives restarts on same disk)
    _secret_file = DATA / ".secret"
    if _secret_file.exists():
        _secret = _secret_file.read_text(encoding="utf-8").strip()
    if not _secret:
        _secret = secrets.token_urlsafe(48)
        try:
            _secret_file.write_text(_secret, encoding="utf-8")
        except OSError:
            pass
SECRET_KEY = _secret
JWT_ALG = "HS256"
TOKEN_TTL = 60 * 60 * 24 * 365 * 2  # 2 years — stay logged in
COOKIE_NAME = "kalagram_token"
MAX_AVATAR = 2 * 1024 * 1024  # 2 MB
MAX_VOICE = 6 * 1024 * 1024  # 6 MB
NICK_RE = re.compile(r"^[a-zA-Zа-яА-ЯёЁ0-9_\-\.]{2,24}$")
IS_CLOUD = _is_cloud()

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ── models ──────────────────────────────────────────────────────
class RegisterIn(BaseModel):
    nick: str = Field(..., min_length=2, max_length=24)
    password: str = Field(..., min_length=4, max_length=72)

    @field_validator("nick")
    @classmethod
    def nick_ok(cls, v: str) -> str:
        v = v.strip()
        if not NICK_RE.match(v):
            raise ValueError("Ник: 2–24 символа, буквы, цифры, _ - .")
        return v


class LoginIn(BaseModel):
    nick: str
    password: str


class MessageIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)


class DeleteMessagesIn(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=100)


class ProfileIn(BaseModel):
    display_name: str | None = Field(None, max_length=48)


class GroupCreateIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    member_ids: list[int] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def name_ok(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Название группы обязательно")
        return v


class GroupMembersIn(BaseModel):
    member_ids: list[int] = Field(..., min_length=1)


# ── auth helpers ────────────────────────────────────────────────
def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return pwd_context.verify(password, hashed)


def make_token(user_id: int, nick: str) -> str:
    payload = {
        "sub": str(user_id),
        "nick": nick,
        "exp": int(time.time()) + TOKEN_TTL,
        "iat": int(time.time()),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALG)


def decode_token(token: str) -> dict[str, Any]:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALG])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Сессия истекла, войдите снова")


def _extract_bearer(authorization: str | None) -> str | None:
    if authorization and authorization.startswith("Bearer "):
        t = authorization[7:].strip()
        return t or None
    return None


async def get_current_user(
    authorization: str | None = Header(default=None),
    kalagram_token: str | None = Cookie(default=None, alias=COOKIE_NAME),
) -> dict[str, Any]:
    raw = _extract_bearer(authorization) or (kalagram_token.strip() if kalagram_token else None)
    if not raw:
        raise HTTPException(status_code=401, detail="Нужна авторизация")
    payload = decode_token(raw)
    try:
        uid = int(payload["sub"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Некорректный токен")
    user = await db_get_user(uid)
    if not user:
        raise HTTPException(status_code=401, detail="Пользователь не найден")
    return user


def attach_auth(response: Response, token: str) -> None:
    # secure=False so cookie works on http://localhost and https:// tunnel
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=TOKEN_TTL,
        httponly=False,
        samesite="lax",
        secure=False,
        path="/",
    )


def clear_auth(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")


# ── database ────────────────────────────────────────────────────
async def init_db() -> None:
    await init_pool()
    await init_schema(DB_PATH)
    # ensure push tables exist even if DB was created before this feature
    try:
        async with connect(DB_PATH) as db:
            if USE_PG:
                await db.execute(
                    """
                    CREATE TABLE IF NOT EXISTS push_subscriptions (
                        endpoint TEXT PRIMARY KEY,
                        user_id INTEGER NOT NULL,
                        p256dh TEXT NOT NULL,
                        auth TEXT NOT NULL,
                        created_at DOUBLE PRECISION NOT NULL
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
            else:
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
    except Exception as e:
        print("  push tables ensure failed:", e)
    mode = "PostgreSQL (постоянно)" if USE_PG else "SQLite (локально / временный диск)"
    print(f"  БД: {mode}")


def user_row(row: aiosqlite.Row | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row["id"],
        "nick": row["nick"],
        "display_name": row["display_name"] or row["nick"],
        "avatar": row["avatar"],
        "created_at": row["created_at"],
        "last_seen": row["last_seen"],
    }


async def db_get_user(user_id: int) -> dict[str, Any] | None:
    async with connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        return user_row(await cur.fetchone())


async def db_get_user_by_nick(nick: str) -> dict[str, Any] | None:
    async with connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT * FROM users WHERE nick = ? COLLATE NOCASE", (nick,)
        )
        row = await cur.fetchone()
        if not row:
            return None
        return {**user_row(row), "password_hash": row["password_hash"]}


async def db_public_user(user_id: int) -> dict[str, Any] | None:
    u = await db_get_user(user_id)
    if not u:
        return None
    return {
        "id": u["id"],
        "nick": u["nick"],
        "display_name": u["display_name"],
        "avatar": u["avatar"],
        "last_seen": u["last_seen"],
        "online": manager.is_online(u["id"]),
    }


def msg_dict(r: aiosqlite.Row | dict) -> dict[str, Any]:
    get = r.__getitem__ if not isinstance(r, dict) else r.get
    return {
        "id": get("id"),
        "sender_id": get("sender_id"),
        "receiver_id": get("receiver_id"),
        "group_id": get("group_id"),
        "text": get("text") or "",
        "msg_type": get("msg_type") or "text",
        "media_url": get("media_url"),
        "duration": get("duration"),
        "created_at": get("created_at"),
        "read_at": get("read_at"),
    }


async def is_group_member(group_id: int, user_id: int) -> bool:
    async with connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?",
            (group_id, user_id),
        )
        return await cur.fetchone() is not None


async def get_group_member_ids(group_id: int) -> list[int]:
    async with connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT user_id FROM group_members WHERE group_id = ?", (group_id,)
        )
        return [r[0] for r in await cur.fetchall()]


async def get_group_info(group_id: int) -> dict[str, Any] | None:
    async with connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM chat_groups WHERE id = ?", (group_id,))
        g = await cur.fetchone()
        if not g:
            return None
        cur = await db.execute(
            """
            SELECT u.id, u.nick, u.display_name, u.avatar, u.last_seen
            FROM group_members gm
            JOIN users u ON u.id = gm.user_id
            WHERE gm.group_id = ?
            ORDER BY u.display_name COLLATE NOCASE
            """,
            (group_id,),
        )
        members = await cur.fetchall()
    return {
        "id": g["id"],
        "name": g["name"],
        "owner_id": g["owner_id"],
        "created_at": g["created_at"],
        "is_group": True,
        "members": [
            {
                "id": m["id"],
                "nick": m["nick"],
                "display_name": m["display_name"] or m["nick"],
                "avatar": m["avatar"],
                "last_seen": m["last_seen"],
                "online": manager.is_online(m["id"]),
            }
            for m in members
        ],
        "member_count": len(members),
    }


async def save_voice_file(content: bytes, content_type: str | None, user_id: int) -> str:
    if len(content) > MAX_VOICE:
        raise HTTPException(status_code=400, detail="Голосовое больше 6 МБ")
    if len(content) < 60:
        raise HTTPException(status_code=400, detail="Слишком короткое голосовое")
    ctype = (content_type or "").lower()
    if "webm" in ctype:
        ext = "webm"
    elif "ogg" in ctype or "opus" in ctype:
        ext = "ogg"
    elif "mp4" in ctype or "m4a" in ctype or "aac" in ctype:
        ext = "m4a"
    elif "mpeg" in ctype or "mp3" in ctype:
        ext = "mp3"
    elif "wav" in ctype:
        ext = "wav"
    else:
        # sniff
        if content[:4] == b"RIFF":
            ext = "wav"
        elif content[:4] == b"OggS":
            ext = "ogg"
        elif content[:4] == b"\x1aE\xdf\xa3":
            ext = "webm"
        elif len(content) > 8 and content[4:8] == b"ftyp":
            ext = "m4a"
        else:
            ext = "webm"
    name = f"{user_id}_{secrets.token_hex(10)}.{ext}"
    mime = {
        "webm": "audio/webm",
        "ogg": "audio/ogg",
        "m4a": "audio/mp4",
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
    }.get(ext, content_type or "application/octet-stream")
    try:
        path = VOICE / name
        path.write_bytes(content)
    except OSError:
        pass
    # always store in DB so media survives Render restarts when using Postgres
    await save_media(name, mime, content, DB_PATH)
    return f"/api/voice/{name}"


async def insert_message(
    *,
    sender_id: int,
    text: str = "",
    receiver_id: int | None = None,
    group_id: int | None = None,
    msg_type: str = "text",
    media_url: str | None = None,
    duration: float | None = None,
) -> dict[str, Any]:
    now = time.time()
    # Older DBs may have receiver_id NOT NULL — use 0 for group messages
    rid = receiver_id if group_id is None else (receiver_id or 0)
    async with connect(DB_PATH) as db:
        cur = await db.execute(
            """
            INSERT INTO messages
              (sender_id, receiver_id, group_id, text, msg_type, media_url, duration, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sender_id,
                rid,
                group_id,
                text or "",
                msg_type,
                media_url,
                duration,
                now,
            ),
        )
        await db.commit()
        mid = cur.lastrowid
    return {
        "id": mid,
        "sender_id": sender_id,
        "receiver_id": receiver_id if group_id is None else None,
        "group_id": group_id,
        "text": text or "",
        "msg_type": msg_type,
        "media_url": media_url,
        "duration": duration,
        "created_at": now,
        "read_at": None,
    }


async def broadcast_message(msg: dict[str, Any], sender: dict[str, Any]) -> None:
    event = {
        "type": "message",
        "message": msg,
        "sender": {
            "id": sender["id"],
            "nick": sender["nick"],
            "display_name": sender["display_name"],
            "avatar": sender["avatar"],
        },
    }
    notify_ids: list[int] = []
    if msg.get("group_id"):
        members = await get_group_member_ids(msg["group_id"])
        for mid in members:
            await manager.send_to(mid, event)
            if mid != sender["id"]:
                notify_ids.append(mid)
    else:
        rid = msg.get("receiver_id")
        if rid:
            await manager.send_to(rid, event)
            if rid != sender["id"]:
                notify_ids.append(int(rid))
        await manager.send_to(sender["id"], event)

    # iPhone/Android home-screen push — only when app is NOT in foreground
    if notify_ids:
        preview = msg.get("text") or ""
        if msg.get("msg_type") == "voice":
            preview = "🎤 Голосовое"
        elif msg.get("msg_type") == "system":
            return
        # Skip users currently looking at Калаграм (they get in-app banner instead)
        push_ids = [uid for uid in notify_ids if not manager.is_app_active(uid)]
        if not push_ids:
            return
        if len(preview) > 120:
            preview = preview[:117] + "…"
        title = sender.get("display_name") or sender.get("nick") or "Калаграм"
        data = {
            "peer_id": msg.get("group_id") or msg.get("sender_id"),
            "group_id": msg.get("group_id"),
            "is_group": bool(msg.get("group_id")),
        }
        await push_notify_users(push_ids, title, preview, data)


async def push_notify_users(
    user_ids: list[int],
    title: str,
    body: str,
    data: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Send web-push to all devices of given users. Returns per-subscription results."""
    results: list[dict[str, Any]] = []
    if not user_ids:
        return results
    try:
        ensure_vapid_keys()
    except Exception as e:
        print("VAPID error", e)
        return [{"result": f"vapid_error:{e}"}]
    async with connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        placeholders = ",".join("?" * len(user_ids))
        cur = await db.execute(
            f"SELECT endpoint, p256dh, auth, user_id FROM push_subscriptions WHERE user_id IN ({placeholders})",
            tuple(user_ids),
        )
        rows = await cur.fetchall()
    gone: list[str] = []
    for r in rows:
        sub = {
            "endpoint": r["endpoint"],
            "keys": {"p256dh": r["p256dh"], "auth": r["auth"]},
        }
        result = await send_web_push(sub, title, body, data)
        print(
            f"push user={r['user_id']} result={result} endpoint={str(r['endpoint'])[:50]}"
        )
        results.append(
            {
                "user_id": r["user_id"],
                "result": result,
                "endpoint": str(r["endpoint"])[:48],
            }
        )
        if result == "gone":
            gone.append(r["endpoint"])
    if not rows:
        print(f"push: no subscriptions for users {user_ids}")
    if gone:
        async with connect(DB_PATH) as db:
            for ep in gone:
                await db.execute(
                    "DELETE FROM push_subscriptions WHERE endpoint = ?", (ep,)
                )
            await db.commit()
    return results


# ── websocket hub ───────────────────────────────────────────────
class ConnectionManager:
    def __init__(self) -> None:
        self.active: dict[int, set[WebSocket]] = {}
        # sockets that reported document visible (user is looking at the app)
        self.foreground: dict[int, set[WebSocket]] = {}
        self.lock = asyncio.Lock()

    async def connect(self, user_id: int, ws: WebSocket) -> None:
        await ws.accept()
        async with self.lock:
            self.active.setdefault(user_id, set()).add(ws)
        await self.broadcast_presence(user_id, True)

    async def disconnect(self, user_id: int, ws: WebSocket) -> None:
        async with self.lock:
            if user_id in self.active:
                self.active[user_id].discard(ws)
                if not self.active[user_id]:
                    del self.active[user_id]
            if user_id in self.foreground:
                self.foreground[user_id].discard(ws)
                if not self.foreground[user_id]:
                    del self.foreground[user_id]
        still = self.is_online(user_id)
        if not still:
            async with connect(DB_PATH) as db:
                await db.execute(
                    "UPDATE users SET last_seen = ? WHERE id = ?",
                    (time.time(), user_id),
                )
                await db.commit()
            await self.broadcast_presence(user_id, False)

    def is_online(self, user_id: int) -> bool:
        return bool(self.active.get(user_id))

    def is_app_active(self, user_id: int) -> bool:
        """True if user has at least one tab/window of Калаграм in the foreground."""
        return bool(self.foreground.get(user_id))

    async def set_app_active(self, user_id: int, ws: WebSocket, active: bool) -> None:
        async with self.lock:
            if active:
                if ws in self.active.get(user_id, set()):
                    self.foreground.setdefault(user_id, set()).add(ws)
            else:
                if user_id in self.foreground:
                    self.foreground[user_id].discard(ws)
                    if not self.foreground[user_id]:
                        del self.foreground[user_id]

    async def send_to(self, user_id: int, data: dict[str, Any]) -> None:
        sockets = list(self.active.get(user_id, set()))
        dead: list[WebSocket] = []
        for ws in sockets:
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.disconnect(user_id, ws)

    async def broadcast_presence(self, user_id: int, online: bool) -> None:
        payload = {
            "type": "presence",
            "user_id": user_id,
            "online": online,
            "last_seen": None if online else time.time(),
        }
        targets: set[int] = set()
        async with connect(DB_PATH) as db:
            cur = await db.execute(
                """
                SELECT user_id FROM contacts WHERE contact_id = ?
                UNION
                SELECT contact_id FROM contacts WHERE user_id = ?
                UNION
                SELECT DISTINCT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END
                FROM messages
                WHERE (sender_id = ? OR receiver_id = ?) AND group_id IS NULL
                  AND receiver_id IS NOT NULL
                UNION
                SELECT gm2.user_id
                FROM group_members gm1
                JOIN group_members gm2 ON gm2.group_id = gm1.group_id
                WHERE gm1.user_id = ? AND gm2.user_id != ?
                """,
                (user_id, user_id, user_id, user_id, user_id, user_id, user_id),
            )
            rows = await cur.fetchall()
            targets = {r[0] for r in rows if r[0] is not None and r[0] != user_id}
        for tid in targets:
            await self.send_to(tid, payload)


manager = ConnectionManager()


# ── app lifecycle ───────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    try:
        await ensure_vapid_keys_db(connect, DB_PATH)
        print("  Push: VAPID keys ready")
    except Exception as e:
        try:
            ensure_vapid_keys()
            print("  Push: VAPID keys ready (file)")
        except Exception as e2:
            print("  Push: VAPID init failed", e, e2)
    yield
    await close_pool()


app = FastAPI(title="Калаграм", lifespan=lifespan)

# Bump this on every user-facing release — client shows «SMS» from Калаграм
APP_VERSION = "1.12"
APP_UPDATE_NOTES = (
    "Обнова 1.12 готова ✓\n"
    "• Голосовые: нажми микрофон → говори → синяя ✓\n"
    "• Разрешение на микрофон — один раз\n"
    "• Можно пользоваться и писать"
)


@app.get("/api/health")
async def health():
    """Public status: which DB backend is active (no secrets)."""
    return {
        "ok": True,
        "app": "Калаграм",
        "version": APP_VERSION,
        "update_notes": APP_UPDATE_NOTES,
        "database": "postgres" if USE_PG else "sqlite",
        "persistent": bool(USE_PG),
        "push": True,
        "hint": (
            "Данные на Neon — переживают перезапуск"
            if USE_PG
            else "SQLite на временном диске Render — после сна/деплоя данные могут пропасть. Добавьте DATABASE_URL (Neon)."
        ),
    }


class PushSubIn(BaseModel):
    endpoint: str
    keys: dict[str, str]


@app.get("/api/push/vapid-public-key")
async def push_vapid_key():
    try:
        return {"publicKey": vapid_public_key()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Push keys: {e}")


@app.post("/api/push/subscribe")
async def push_subscribe(body: PushSubIn, user: dict = Depends(get_current_user)):
    p256dh = (body.keys or {}).get("p256dh") or ""
    auth = (body.keys or {}).get("auth") or ""
    if not body.endpoint or not p256dh or not auth:
        raise HTTPException(status_code=400, detail="Некорректная подписка")
    now = time.time()
    async with connect(DB_PATH) as db:
        # upsert
        if USE_PG:
            await db.execute(
                """
                INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (endpoint) DO UPDATE SET
                  user_id = EXCLUDED.user_id,
                  p256dh = EXCLUDED.p256dh,
                  auth = EXCLUDED.auth,
                  created_at = EXCLUDED.created_at
                """,
                (body.endpoint, user["id"], p256dh, auth, now),
            )
        else:
            await db.execute(
                "DELETE FROM push_subscriptions WHERE endpoint = ?", (body.endpoint,)
            )
            await db.execute(
                """
                INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (body.endpoint, user["id"], p256dh, auth, now),
            )
            await db.commit()
    return {"ok": True}


@app.delete("/api/push/subscribe")
async def push_unsubscribe(body: PushSubIn, user: dict = Depends(get_current_user)):
    async with connect(DB_PATH) as db:
        # allow delete by endpoint only for this user (keys may be dummy)
        if body.endpoint:
            await db.execute(
                "DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?",
                (body.endpoint, user["id"]),
            )
        else:
            await db.execute(
                "DELETE FROM push_subscriptions WHERE user_id = ?",
                (user["id"],),
            )
        await db.commit()
    return {"ok": True}


def _row_count(row) -> int:
    if not row:
        return 0
    try:
        return int(row["c"])
    except Exception:
        try:
            return int(row[0])
        except Exception:
            return 0


async def _count_push_subs(user_id: int) -> int:
    async with connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?",
            (user_id,),
        )
        return _row_count(await cur.fetchone())


@app.get("/api/push/status")
async def push_status(user: dict = Depends(get_current_user)):
    try:
        count = await _count_push_subs(user["id"])
        pub = ""
        try:
            pub = (vapid_public_key() or "")[:16]
        except Exception:
            pub = ""
        return {
            "subscriptions": count,
            "publicKeyPrefix": pub,
            "ok": count > 0,
        }
    except Exception as e:
        print("push_status error", e)
        raise HTTPException(status_code=500, detail=f"push status: {e}")


@app.post("/api/push/test")
async def push_test(user: dict = Depends(get_current_user)):
    """Send a test notification to the current user's devices."""
    try:
        count = await _count_push_subs(user["id"])
    except Exception as e:
        print("push_test count error", e)
        raise HTTPException(
            status_code=500,
            detail=f"Ошибка БД подписок: {e}. Обновите сайт и снова «Включить уведомления».",
        )
    if count == 0:
        raise HTTPException(
            status_code=400,
            detail="Подписка не найдена. Откройте Калаграм с «Домой» → Профиль → Включить уведомления.",
        )
    try:
        results = await push_notify_users(
            [user["id"]],
            "Калаграм",
            "Тест: уведомления работают ✓",
            {"test": True},
        )
    except Exception as e:
        print("push_test send error", e)
        raise HTTPException(status_code=500, detail=f"Не удалось отправить push: {e}")
    oks = sum(1 for r in results if r.get("result") == "ok")
    if oks == 0:
        detail = "; ".join(f"{r.get('result')}" for r in results) or "нет результата"
        raise HTTPException(
            status_code=502,
            detail=f"Сервер не смог доставить push ({detail}). Нажмите «Включить уведомления» ещё раз.",
        )
    return {"ok": True, "subscriptions": count, "delivered": oks, "results": results}


# ── auth routes ─────────────────────────────────────────────────
@app.post("/api/register")
async def register(body: RegisterIn):
    existing = await db_get_user_by_nick(body.nick)
    if existing:
        raise HTTPException(status_code=400, detail="Этот ник уже занят")
    now = time.time()
    async with connect(DB_PATH) as db:
        try:
            cur = await db.execute(
                """
                INSERT INTO users (nick, password_hash, display_name, created_at, last_seen)
                VALUES (?, ?, ?, ?, ?)
                """,
                (body.nick.strip(), hash_password(body.password), body.nick.strip(), now, now),
            )
            await db.commit()
            uid = cur.lastrowid
        except Exception as e:
            err = str(e).lower()
            if "unique" in err or "integrity" in err or type(e).__name__ == "IntegrityError":
                raise HTTPException(status_code=400, detail="Этот ник уже занят")
            raise
    user = await db_get_user(uid)
    token = make_token(uid, user["nick"])
    payload = {"token": token, "user": {**user, "online": True}}
    resp = JSONResponse(payload)
    attach_auth(resp, token)
    return resp


@app.post("/api/login")
async def login(body: LoginIn):
    row = await db_get_user_by_nick(body.nick.strip())
    if not row:
        raise HTTPException(
            status_code=401,
            detail="Пользователь не найден. На free-хостинге без DATABASE_URL данные сбрасываются — зарегистрируйтесь снова.",
        )
    if not verify_password(body.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Неверный ник или пароль")
    user = {
        "id": row["id"],
        "nick": row["nick"],
        "display_name": row["display_name"],
        "avatar": row["avatar"],
        "created_at": row["created_at"],
        "last_seen": row["last_seen"],
        "online": True,
    }
    token = make_token(user["id"], user["nick"])
    async with connect(DB_PATH) as db:
        await db.execute(
            "UPDATE users SET last_seen = ? WHERE id = ?", (time.time(), user["id"])
        )
        await db.commit()
    resp = JSONResponse({"token": token, "user": user})
    attach_auth(resp, token)
    return resp


@app.get("/api/me")
async def me(user: dict = Depends(get_current_user)):
    # silently renew long-lived session
    token = make_token(user["id"], user["nick"])
    resp = JSONResponse({**user, "online": True, "token": token})
    attach_auth(resp, token)
    return resp


@app.post("/api/refresh")
async def refresh_session(user: dict = Depends(get_current_user)):
    token = make_token(user["id"], user["nick"])
    resp = JSONResponse({"token": token, "user": {**user, "online": True}})
    attach_auth(resp, token)
    return resp


@app.post("/api/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    clear_auth(resp)
    return resp


@app.patch("/api/me")
async def update_me(body: ProfileIn, user: dict = Depends(get_current_user)):
    if body.display_name is not None:
        name = body.display_name.strip() or user["nick"]
        async with connect(DB_PATH) as db:
            await db.execute(
                "UPDATE users SET display_name = ? WHERE id = ?", (name, user["id"])
            )
            await db.commit()
    return await db_public_user(user["id"])


@app.post("/api/me/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    content = await file.read()
    if len(content) > MAX_AVATAR:
        raise HTTPException(status_code=400, detail="Файл больше 2 МБ")
    if not content:
        raise HTTPException(status_code=400, detail="Пустой файл")
    # Detect type by magic bytes first (more reliable than browser Content-Type)
    if content[:3] == b"\xff\xd8\xff":
        ext, mime = "jpg", "image/jpeg"
    elif content[:8] == b"\x89PNG\r\n\x1a\n":
        ext, mime = "png", "image/png"
    elif content[:6] in (b"GIF87a", b"GIF89a"):
        ext, mime = "gif", "image/gif"
    elif content[:4] == b"RIFF" and b"WEBP" in content[:16]:
        ext, mime = "webp", "image/webp"
    else:
        ctype = (file.content_type or "").lower()
        if ctype in ("image/jpeg", "image/jpg"):
            ext, mime = "jpg", "image/jpeg"
        elif ctype == "image/png":
            ext, mime = "png", "image/png"
        elif ctype == "image/webp":
            ext, mime = "webp", "image/webp"
        elif ctype == "image/gif":
            ext, mime = "gif", "image/gif"
        else:
            raise HTTPException(
                status_code=400,
                detail="Нужно фото JPG/PNG. На iPhone: «Файл» → снимок или «Самое совместимое».",
            )

    if user.get("avatar"):
        old = AVATARS / Path(user["avatar"]).name
        if old.exists() and old.parent == AVATARS:
            try:
                old.unlink()
            except OSError:
                pass

    name = f"{user['id']}_{secrets.token_hex(8)}.{ext}"
    try:
        path = AVATARS / name
        path.write_bytes(content)
    except OSError:
        pass
    await save_media(name, mime, content, DB_PATH)
    avatar_url = f"/api/avatars/{name}"
    async with connect(DB_PATH) as db:
        await db.execute(
            "UPDATE users SET avatar = ? WHERE id = ?", (avatar_url, user["id"])
        )
        await db.commit()
    return await db_public_user(user["id"])


@app.get("/api/avatars/{filename}")
async def get_avatar(filename: str):
    safe = Path(filename).name
    path = AVATARS / safe
    if path.exists() and path.is_file():
        return FileResponse(path)
    stored = await load_media(safe, DB_PATH)
    if not stored:
        raise HTTPException(status_code=404)
    data, ctype = stored
    return Response(content=data, media_type=ctype)


def _media_response(request: Request, data: bytes, media_type: str) -> Response:
    """Serve bytes with HTTP Range — required for audio on iOS Safari."""
    size = len(data)
    ctype = media_type or "application/octet-stream"
    base_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=86400",
        "Content-Type": ctype,
    }
    range_header = (request.headers.get("range") or "").strip()
    if not range_header.startswith("bytes="):
        return Response(
            content=data,
            media_type=ctype,
            headers={**base_headers, "Content-Length": str(size)},
        )
    # bytes=start-end
    try:
        spec = range_header[6:].split(",")[0].strip()
        start_s, _, end_s = spec.partition("-")
        if start_s == "":
            # suffix: bytes=-N
            length = int(end_s)
            start = max(0, size - length)
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        if start < 0 or start >= size:
            return Response(
                status_code=416,
                headers={**base_headers, "Content-Range": f"bytes */{size}"},
            )
        end = min(end, size - 1)
        if end < start:
            return Response(
                status_code=416,
                headers={**base_headers, "Content-Range": f"bytes */{size}"},
            )
        chunk = data[start : end + 1]
        return Response(
            content=chunk,
            status_code=206,
            media_type=ctype,
            headers={
                **base_headers,
                "Content-Length": str(len(chunk)),
                "Content-Range": f"bytes {start}-{end}/{size}",
            },
        )
    except (ValueError, IndexError):
        return Response(
            content=data,
            media_type=ctype,
            headers={**base_headers, "Content-Length": str(size)},
        )


@app.get("/api/voice/{filename}")
async def get_voice(filename: str, request: Request):
    safe = Path(filename).name
    if not safe or safe != filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Bad filename")
    path = VOICE / safe
    media_map = {
        ".webm": "audio/webm",
        ".ogg": "audio/ogg",
        ".m4a": "audio/mp4",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
    }
    # Prefer DB (survives Render disk wipe); fall back to local file
    stored = await load_media(safe, DB_PATH)
    if stored:
        data, ctype = stored
        if not ctype or ctype == "application/octet-stream":
            ctype = media_map.get(path.suffix.lower(), ctype or "application/octet-stream")
        return _media_response(request, data, ctype)
    if path.exists() and path.is_file():
        data = path.read_bytes()
        ctype = media_map.get(path.suffix.lower(), "application/octet-stream")
        return _media_response(request, data, ctype)
    raise HTTPException(status_code=404, detail="Голосовое не найдено")


# ── users & contacts ────────────────────────────────────────────
@app.get("/api/users/search")
async def search_users(q: str = "", user: dict = Depends(get_current_user)):
    q = q.strip()
    if len(q) < 1:
        return []
    like = f"%{q}%"
    async with connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT id, nick, display_name, avatar, last_seen
            FROM users
            WHERE id != ?
              AND (nick LIKE ? COLLATE NOCASE OR display_name LIKE ? COLLATE NOCASE)
            ORDER BY nick
            LIMIT 30
            """,
            (user["id"], like, like),
        )
        rows = await cur.fetchall()
        ccur = await db.execute(
            "SELECT contact_id FROM contacts WHERE user_id = ?", (user["id"],)
        )
        contact_ids = {r[0] for r in await ccur.fetchall()}
    return [
        {
            "id": r["id"],
            "nick": r["nick"],
            "display_name": r["display_name"] or r["nick"],
            "avatar": r["avatar"],
            "last_seen": r["last_seen"],
            "online": manager.is_online(r["id"]),
            "is_contact": r["id"] in contact_ids,
        }
        for r in rows
    ]


@app.get("/api/contacts")
async def list_contacts(user: dict = Depends(get_current_user)):
    async with connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT u.id, u.nick, u.display_name, u.avatar, u.last_seen, c.created_at
            FROM contacts c
            JOIN users u ON u.id = c.contact_id
            WHERE c.user_id = ?
            ORDER BY u.display_name COLLATE NOCASE, u.nick COLLATE NOCASE
            """,
            (user["id"],),
        )
        rows = await cur.fetchall()
    return [
        {
            "id": r["id"],
            "nick": r["nick"],
            "display_name": r["display_name"] or r["nick"],
            "avatar": r["avatar"],
            "last_seen": r["last_seen"],
            "online": manager.is_online(r["id"]),
            "is_contact": True,
        }
        for r in rows
    ]


@app.post("/api/contacts/{contact_id}")
async def add_contact(contact_id: int, user: dict = Depends(get_current_user)):
    if contact_id == user["id"]:
        raise HTTPException(status_code=400, detail="Нельзя добавить себя")
    target = await db_get_user(contact_id)
    if not target:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    async with connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT OR IGNORE INTO contacts (user_id, contact_id, created_at)
            VALUES (?, ?, ?)
            """,
            (user["id"], contact_id, time.time()),
        )
        await db.commit()
    return await db_public_user(contact_id)


@app.delete("/api/contacts/{contact_id}")
async def remove_contact(contact_id: int, user: dict = Depends(get_current_user)):
    async with connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM contacts WHERE user_id = ? AND contact_id = ?",
            (user["id"], contact_id),
        )
        await db.commit()
    return {"ok": True}


# ── groups ──────────────────────────────────────────────────────
@app.post("/api/groups")
async def create_group(body: GroupCreateIn, user: dict = Depends(get_current_user)):
    member_ids = list({int(x) for x in body.member_ids if int(x) != user["id"]})
    if not member_ids:
        raise HTTPException(status_code=400, detail="Добавьте хотя бы одного участника")
    # validate members exist
    for mid in member_ids:
        if not await db_get_user(mid):
            raise HTTPException(status_code=404, detail=f"Пользователь {mid} не найден")
    now = time.time()
    all_ids = [user["id"], *member_ids]
    async with connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO chat_groups (name, owner_id, created_at) VALUES (?, ?, ?)",
            (body.name, user["id"], now),
        )
        gid = cur.lastrowid
        for mid in all_ids:
            await db.execute(
                "INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)",
                (gid, mid, now),
            )
            await db.execute(
                """
                INSERT OR IGNORE INTO group_reads (group_id, user_id, last_read_id)
                VALUES (?, ?, 0)
                """,
                (gid, mid),
            )
        await db.commit()
    # system-like first message
    msg = await insert_message(
        sender_id=user["id"],
        group_id=gid,
        text=f"Группа «{body.name}» создана",
        msg_type="system",
    )
    await broadcast_message(msg, user)
    info = await get_group_info(gid)
    return info


@app.get("/api/groups/{group_id}")
async def group_detail(group_id: int, user: dict = Depends(get_current_user)):
    if not await is_group_member(group_id, user["id"]):
        raise HTTPException(status_code=403, detail="Вы не в этой группе")
    info = await get_group_info(group_id)
    if not info:
        raise HTTPException(status_code=404, detail="Группа не найдена")
    return info


@app.post("/api/groups/{group_id}/members")
async def add_group_members(
    group_id: int,
    body: GroupMembersIn,
    user: dict = Depends(get_current_user),
):
    if not await is_group_member(group_id, user["id"]):
        raise HTTPException(status_code=403, detail="Вы не в этой группе")
    now = time.time()
    added = []
    async with connect(DB_PATH) as db:
        for mid in body.member_ids:
            if mid == user["id"]:
                continue
            if not await db_get_user(mid):
                continue
            cur = await db.execute(
                "INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)",
                (group_id, mid, now),
            )
            if cur.rowcount:
                await db.execute(
                    "INSERT OR IGNORE INTO group_reads (group_id, user_id, last_read_id) VALUES (?, ?, 0)",
                    (group_id, mid),
                )
                added.append(mid)
        await db.commit()
    if added:
        names = []
        for mid in added:
            u = await db_get_user(mid)
            if u:
                names.append(u["display_name"])
        msg = await insert_message(
            sender_id=user["id"],
            group_id=group_id,
            text="Добавлены: " + ", ".join(names),
            msg_type="system",
        )
        await broadcast_message(msg, user)
    return await get_group_info(group_id)


@app.get("/api/groups/{group_id}/messages")
async def get_group_messages(
    group_id: int,
    before: int | None = None,
    limit: int = 50,
    user: dict = Depends(get_current_user),
):
    if not await is_group_member(group_id, user["id"]):
        raise HTTPException(status_code=403, detail="Вы не в этой группе")
    limit = max(1, min(limit, 100))
    info = await get_group_info(group_id)
    if not info:
        raise HTTPException(status_code=404, detail="Группа не найдена")
    async with connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if before:
            cur = await db.execute(
                """
                SELECT * FROM messages
                WHERE group_id = ? AND id < ?
                ORDER BY id DESC LIMIT ?
                """,
                (group_id, before, limit),
            )
        else:
            cur = await db.execute(
                """
                SELECT * FROM messages
                WHERE group_id = ?
                ORDER BY id DESC LIMIT ?
                """,
                (group_id, limit),
            )
        rows = list(reversed(await cur.fetchall()))
        max_id = rows[-1]["id"] if rows else 0
        if max_id:
            await db.execute(
                """
                INSERT INTO group_reads (group_id, user_id, last_read_id)
                VALUES (?, ?, ?)
                ON CONFLICT(group_id, user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)
                """,
                (group_id, user["id"], max_id),
            )
            await db.commit()
    # attach sender mini-profiles
    messages = []
    for r in rows:
        m = msg_dict(r)
        su = await db_public_user(m["sender_id"])
        m["sender"] = su
        messages.append(m)
    return {"group": info, "messages": messages}


@app.post("/api/groups/{group_id}/messages")
async def send_group_message(
    group_id: int,
    body: MessageIn,
    user: dict = Depends(get_current_user),
):
    if not await is_group_member(group_id, user["id"]):
        raise HTTPException(status_code=403, detail="Вы не в этой группе")
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Пустое сообщение")
    msg = await insert_message(
        sender_id=user["id"], group_id=group_id, text=text, msg_type="text"
    )
    su = await db_public_user(user["id"])
    msg["sender"] = su
    await broadcast_message(msg, user)
    return msg


@app.post("/api/groups/{group_id}/voice")
async def send_group_voice(
    group_id: int,
    file: UploadFile = File(...),
    duration: float = Form(0),
    user: dict = Depends(get_current_user),
):
    if not await is_group_member(group_id, user["id"]):
        raise HTTPException(status_code=403, detail="Вы не в этой группе")
    content = await file.read()
    url = await save_voice_file(content, file.content_type, user["id"])
    dur = max(0.0, min(float(duration or 0), 300.0))
    msg = await insert_message(
        sender_id=user["id"],
        group_id=group_id,
        text="🎤 Голосовое",
        msg_type="voice",
        media_url=url,
        duration=dur or None,
    )
    su = await db_public_user(user["id"])
    msg["sender"] = su
    await broadcast_message(msg, user)
    return msg


# ── chats & messages ────────────────────────────────────────────
@app.get("/api/chats")
async def list_chats(user: dict = Depends(get_current_user)):
    uid = user["id"]
    chats: list[dict[str, Any]] = []
    async with connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        # private chats
        cur = await db.execute(
            """
            SELECT
                peer.id AS peer_id,
                peer.nick,
                peer.display_name,
                peer.avatar,
                peer.last_seen,
                m.id AS last_msg_id,
                m.text AS last_text,
                m.msg_type AS last_type,
                m.created_at AS last_at,
                m.sender_id AS last_sender,
                (
                    SELECT COUNT(*) FROM messages um
                    WHERE um.sender_id = peer.id AND um.receiver_id = ?
                      AND um.group_id IS NULL AND um.read_at IS NULL
                ) AS unread
            FROM (
                SELECT
                    CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS peer_id,
                    MAX(id) AS mid
                FROM messages
                WHERE group_id IS NULL
                  AND receiver_id IS NOT NULL
                  AND (sender_id = ? OR receiver_id = ?)
                GROUP BY peer_id
            ) t
            JOIN messages m ON m.id = t.mid
            JOIN users peer ON peer.id = t.peer_id
            """,
            (uid, uid, uid, uid),
        )
        for r in await cur.fetchall():
            preview = r["last_text"] or ""
            if r["last_type"] == "voice":
                preview = "🎤 Голосовое"
            chats.append(
                {
                    "kind": "dm",
                    "peer": {
                        "id": r["peer_id"],
                        "nick": r["nick"],
                        "display_name": r["display_name"] or r["nick"],
                        "avatar": r["avatar"],
                        "last_seen": r["last_seen"],
                        "online": manager.is_online(r["peer_id"]),
                        "is_group": False,
                    },
                    "last_message": {
                        "id": r["last_msg_id"],
                        "text": preview,
                        "msg_type": r["last_type"] or "text",
                        "created_at": r["last_at"],
                        "sender_id": r["last_sender"],
                    },
                    "unread": r["unread"],
                    "sort_at": r["last_at"],
                }
            )
        # group chats
        cur = await db.execute(
            """
            SELECT
                g.id AS group_id,
                g.name,
                g.owner_id,
                m.id AS last_msg_id,
                m.text AS last_text,
                m.msg_type AS last_type,
                m.created_at AS last_at,
                m.sender_id AS last_sender,
                su.display_name AS sender_name,
                su.nick AS sender_nick,
                COALESCE(gr.last_read_id, 0) AS last_read_id,
                (
                    SELECT COUNT(*) FROM messages um
                    WHERE um.group_id = g.id
                      AND um.id > COALESCE(gr.last_read_id, 0)
                      AND um.sender_id != ?
                ) AS unread,
                (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id) AS member_count
            FROM group_members gm
            JOIN chat_groups g ON g.id = gm.group_id
            LEFT JOIN group_reads gr ON gr.group_id = g.id AND gr.user_id = ?
            LEFT JOIN messages m ON m.id = (
                SELECT id FROM messages WHERE group_id = g.id ORDER BY id DESC LIMIT 1
            )
            LEFT JOIN users su ON su.id = m.sender_id
            WHERE gm.user_id = ?
            """,
            (uid, uid, uid),
        )
        for r in await cur.fetchall():
            if not r["last_msg_id"] and not r["group_id"]:
                continue
            preview = r["last_text"] or "Группа создана"
            if r["last_type"] == "voice":
                preview = "🎤 Голосовое"
            if r["last_sender"] and r["last_sender"] != uid and r["last_type"] != "system":
                sn = r["sender_name"] or r["sender_nick"] or ""
                if sn:
                    preview = f"{sn}: {preview}"
            chats.append(
                {
                    "kind": "group",
                    "peer": {
                        "id": r["group_id"],
                        "nick": "",
                        "display_name": r["name"],
                        "avatar": None,
                        "last_seen": None,
                        "online": False,
                        "is_group": True,
                        "member_count": r["member_count"],
                    },
                    "last_message": {
                        "id": r["last_msg_id"],
                        "text": preview,
                        "msg_type": r["last_type"] or "text",
                        "created_at": r["last_at"] or 0,
                        "sender_id": r["last_sender"],
                    },
                    "unread": r["unread"] or 0,
                    "sort_at": r["last_at"] or 0,
                }
            )
    chats.sort(key=lambda c: c.get("sort_at") or 0, reverse=True)
    for c in chats:
        c.pop("sort_at", None)
    return chats


@app.get("/api/messages/{peer_id}")
async def get_messages(
    peer_id: int,
    before: int | None = None,
    limit: int = 50,
    user: dict = Depends(get_current_user),
):
    limit = max(1, min(limit, 100))
    peer = await db_get_user(peer_id)
    if not peer:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    uid = user["id"]
    async with connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if before:
            cur = await db.execute(
                """
                SELECT * FROM messages
                WHERE group_id IS NULL
                  AND ((sender_id = ? AND receiver_id = ?)
                    OR (sender_id = ? AND receiver_id = ?))
                  AND id < ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (uid, peer_id, peer_id, uid, before, limit),
            )
        else:
            cur = await db.execute(
                """
                SELECT * FROM messages
                WHERE group_id IS NULL
                  AND ((sender_id = ? AND receiver_id = ?)
                    OR (sender_id = ? AND receiver_id = ?))
                ORDER BY id DESC
                LIMIT ?
                """,
                (uid, peer_id, peer_id, uid, limit),
            )
        rows = list(reversed(await cur.fetchall()))
        await db.execute(
            """
            UPDATE messages SET read_at = ?
            WHERE group_id IS NULL
              AND sender_id = ? AND receiver_id = ? AND read_at IS NULL
            """,
            (time.time(), peer_id, uid),
        )
        await db.commit()
    await manager.send_to(
        peer_id,
        {"type": "read", "reader_id": uid, "peer_id": peer_id},
    )
    return {
        "peer": {
            "id": peer["id"],
            "nick": peer["nick"],
            "display_name": peer["display_name"],
            "avatar": peer["avatar"],
            "last_seen": peer["last_seen"],
            "online": manager.is_online(peer["id"]),
            "is_group": False,
        },
        "messages": [msg_dict(r) for r in rows],
    }


@app.post("/api/messages/bulk-delete")
async def delete_messages(body: DeleteMessagesIn, user: dict = Depends(get_current_user)):
    """Delete messages for everyone (any message in chats you're part of)."""
    ids = [int(i) for i in body.ids if int(i) > 0]
    if not ids:
        raise HTTPException(status_code=400, detail="Нечего удалять")
    placeholders = ",".join("?" * len(ids))
    uid = int(user["id"])
    async with connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            f"SELECT id, sender_id, receiver_id, group_id FROM messages WHERE id IN ({placeholders})",
            tuple(ids),
        )
        rows = await cur.fetchall()
        allowed: list[int] = []
        peers: set[int] = set()
        groups: set[int] = set()
        for r in rows:
            mid = int(r["id"])
            gid = r["group_id"]
            sid = int(r["sender_id"])
            rid = int(r["receiver_id"] or 0)
            if gid:
                # must be group member
                ok = await is_group_member(int(gid), uid)
                if not ok:
                    continue
                allowed.append(mid)
                groups.add(int(gid))
            else:
                # DM: user must be sender or receiver
                if uid not in (sid, rid):
                    continue
                allowed.append(mid)
                peers.add(sid)
                if rid:
                    peers.add(rid)
        if not allowed:
            raise HTTPException(status_code=400, detail="Нет доступа к этим сообщениям")
        ph2 = ",".join("?" * len(allowed))
        await db.execute(f"DELETE FROM messages WHERE id IN ({ph2})", tuple(allowed))
        await db.commit()

    event = {"type": "messages_deleted", "ids": allowed, "by": uid}
    targets: set[int] = set(peers)
    for g in groups:
        for mid in await get_group_member_ids(g):
            targets.add(mid)
    targets.add(uid)
    for tid in targets:
        await manager.send_to(tid, event)
    return {"ok": True, "deleted": allowed}


class DeleteChatsIn(BaseModel):
    items: list[dict[str, Any]] = Field(..., min_length=1, max_length=50)


@app.post("/api/chats/bulk-delete")
async def delete_chats(body: DeleteChatsIn, user: dict = Depends(get_current_user)):
    """Delete entire chats for everyone (all messages in DM/group)."""
    uid = int(user["id"])
    deleted_dms: list[int] = []
    deleted_groups: list[int] = []
    targets: set[int] = {uid}

    for item in body.items:
        kind = (item.get("kind") or item.get("type") or "dm").lower()
        cid = int(item.get("id") or 0)
        if cid <= 0:
            continue
        if kind == "group":
            if not await is_group_member(cid, uid):
                continue
            members = await get_group_member_ids(cid)
            targets.update(members)
            async with connect(DB_PATH) as db:
                await db.execute("DELETE FROM messages WHERE group_id = ?", (cid,))
                await db.execute("DELETE FROM group_reads WHERE group_id = ?", (cid,))
                await db.execute("DELETE FROM group_members WHERE group_id = ?", (cid,))
                await db.execute("DELETE FROM chat_groups WHERE id = ?", (cid,))
                await db.commit()
            deleted_groups.append(cid)
        else:
            # DM with peer cid
            peer = await db_get_user(cid)
            if not peer:
                continue
            targets.add(cid)
            async with connect(DB_PATH) as db:
                await db.execute(
                    """
                    DELETE FROM messages
                    WHERE group_id IS NULL
                      AND (
                        (sender_id = ? AND receiver_id = ?)
                        OR (sender_id = ? AND receiver_id = ?)
                      )
                    """,
                    (uid, cid, cid, uid),
                )
                await db.commit()
            deleted_dms.append(cid)

    event = {
        "type": "chats_deleted",
        "dms": deleted_dms,
        "groups": deleted_groups,
        "by": uid,
    }
    for tid in targets:
        await manager.send_to(tid, event)
    return {"ok": True, "dms": deleted_dms, "groups": deleted_groups}


@app.post("/api/messages/{peer_id}")
async def send_message(
    peer_id: int,
    body: MessageIn,
    user: dict = Depends(get_current_user),
):
    if peer_id == user["id"]:
        raise HTTPException(status_code=400, detail="Нельзя писать себе")
    peer = await db_get_user(peer_id)
    if not peer:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Пустое сообщение")
    msg = await insert_message(
        sender_id=user["id"],
        receiver_id=peer_id,
        text=text,
        msg_type="text",
    )
    await broadcast_message(msg, user)
    now = time.time()
    async with connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR IGNORE INTO contacts (user_id, contact_id, created_at) VALUES (?, ?, ?)",
            (user["id"], peer_id, now),
        )
        await db.commit()
    return msg


@app.post("/api/messages/{peer_id}/voice")
async def send_voice(
    peer_id: int,
    file: UploadFile = File(...),
    duration: float = Form(0),
    user: dict = Depends(get_current_user),
):
    if peer_id == user["id"]:
        raise HTTPException(status_code=400, detail="Нельзя писать себе")
    peer = await db_get_user(peer_id)
    if not peer:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    content = await file.read()
    url = await save_voice_file(content, file.content_type, user["id"])
    dur = max(0.0, min(float(duration or 0), 300.0))
    msg = await insert_message(
        sender_id=user["id"],
        receiver_id=peer_id,
        text="🎤 Голосовое",
        msg_type="voice",
        media_url=url,
        duration=dur or None,
    )
    await broadcast_message(msg, user)
    now = time.time()
    async with connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR IGNORE INTO contacts (user_id, contact_id, created_at) VALUES (?, ?, ?)",
            (user["id"], peer_id, now),
        )
        await db.commit()
    return msg


# ── websocket ───────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = ""):
    if not token:
        await ws.close(code=4401)
        return
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALG])
        user_id = int(payload["sub"])
    except Exception:
        await ws.close(code=4401)
        return
    user = await db_get_user(user_id)
    if not user:
        await ws.close(code=4401)
        return
    await manager.connect(user_id, ws)
    try:
        while True:
            data = await ws.receive_text()
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "typing":
                peer = obj.get("peer_id")
                group_id = obj.get("group_id")
                if group_id:
                    if await is_group_member(int(group_id), user_id):
                        for mid in await get_group_member_ids(int(group_id)):
                            if mid != user_id:
                                await manager.send_to(
                                    mid,
                                    {
                                        "type": "typing",
                                        "user_id": user_id,
                                        "group_id": int(group_id),
                                    },
                                )
                elif peer:
                    await manager.send_to(
                        int(peer),
                        {"type": "typing", "user_id": user_id, "peer_id": int(peer)},
                    )
            elif obj.get("type") == "ping":
                await ws.send_json({"type": "pong"})
            elif obj.get("type") == "app_active":
                # Client reports document visibility — skip push while true
                active = bool(obj.get("active", False))
                await manager.set_app_active(user_id, ws, active)
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(user_id, ws)


# ── static & PWA ────────────────────────────────────────────────
@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(
        STATIC / "manifest.webmanifest",
        media_type="application/manifest+json",
    )


@app.get("/sw.js")
async def service_worker():
    return FileResponse(STATIC / "sw.js", media_type="application/javascript")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/ca.cer")
async def download_ca_cert():
    """Download local CA so iPhone/desktop can trust HTTPS without warning."""
    path = DATA / "ca.cer"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Сертификат ещё не создан")
    return FileResponse(
        path,
        media_type="application/x-x509-ca-cert",
        filename="messenger-ca.cer",
    )


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    if full_path.startswith("api/") or full_path.startswith("ws"):
        raise HTTPException(status_code=404)
    candidate = STATIC / full_path
    if candidate.is_file() and STATIC in candidate.resolve().parents:
        return FileResponse(candidate)
    return FileResponse(STATIC / "index.html")


def _local_ips() -> list[str]:
    ips = ["127.0.0.1", "localhost"]
    try:
        import socket

        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip and ip not in ips and not ip.startswith("127."):
                ips.append(ip)
        # default route interface guess
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip and ip not in ips:
                ips.append(ip)
        finally:
            s.close()
    except Exception:
        pass
    return ips


def ensure_ssl_certs(force: bool = False) -> tuple[Path, Path]:
    """Local CA + server cert. iPhone can install ca.cer to trust the site."""
    import ipaddress
    from datetime import datetime, timedelta, timezone

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    cert_file = DATA / "cert.pem"
    key_file = DATA / "key.pem"
    ca_pem = DATA / "ca.pem"
    ca_cer = DATA / "ca.cer"  # DER for iOS install
    marker = DATA / "ssl_v2"

    if (
        not force
        and cert_file.exists()
        and key_file.exists()
        and ca_cer.exists()
        and marker.exists()
    ):
        return cert_file, key_file

    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, "Messenger Home CA"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Messenger Local"),
        ]
    )
    now = datetime.now(timezone.utc)
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_cert_sign=True,
                crl_sign=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )

    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    server_name = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, "Messenger Local Server")]
    )
    san_list: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
    ]
    for ip in _local_ips():
        try:
            if ip.count(".") == 3 and all(p.isdigit() for p in ip.split(".")):
                san_list.append(x509.IPAddress(ipaddress.IPv4Address(ip)))
            elif ip not in ("localhost",):
                san_list.append(x509.DNSName(ip))
        except Exception:
            continue

    server_cert = (
        x509.CertificateBuilder()
        .subject_name(server_name)
        .issuer_name(ca_name)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san_list), critical=False)
        .add_extension(
            x509.BasicConstraints(ca=False, path_length=None), critical=True
        )
        .add_extension(
            x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )

    # chain: server + CA (some clients like the chain)
    cert_file.write_bytes(
        server_cert.public_bytes(serialization.Encoding.PEM)
        + ca_cert.public_bytes(serialization.Encoding.PEM)
    )
    key_file.write_bytes(
        server_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    ca_pem.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    ca_cer.write_bytes(ca_cert.public_bytes(serialization.Encoding.DER))
    marker.write_text("2", encoding="utf-8")
    print(f"  Созданы сертификаты: {cert_file.name}, {ca_cer.name}")
    return cert_file, key_file


def start_trust_helper(host: str, port: int = 8080) -> None:
    """Plain HTTP page to download CA (so iPhone can install trust without HTTPS warning)."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    ca_cer = DATA / "ca.cer"
    lan = [ip for ip in _local_ips() if ip not in ("127.0.0.1", "localhost")]
    https_links = "".join(
        f'<li><a href="https://{ip}:8000">https://{ip}:8000</a></li>' for ip in lan
    ) or "<li><a href='https://localhost:8000'>https://localhost:8000</a></li>"

    page = f"""<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Доверие к мессенджеру</title>
<style>
body{{font-family:-apple-system,system-ui,sans-serif;background:#0b0d12;color:#f2f4f8;
margin:0;padding:24px;line-height:1.5;max-width:520px;margin-inline:auto}}
h1{{font-size:1.35rem;margin:0 0 8px}}
p,li{{color:#9aa3b5;font-size:.95rem}}
a.btn{{display:block;text-align:center;background:linear-gradient(135deg,#5b7cfa,#7b5cff);
color:#fff;text-decoration:none;padding:14px;border-radius:12px;font-weight:700;margin:16px 0}}
.card{{background:#12151c;border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:18px;margin-top:16px}}
ol{{padding-left:1.2rem}}
strong{{color:#f2f4f8}}
code{{color:#8aa4ff}}
</style></head><body>
<h1>Подключение «не защищено» — это нормально</h1>
<p>Сайт домашний, сертификат свой. Браузер предупреждает, пока вы не доверите сертификату.</p>
<div class="card">
<h2 style="font-size:1.05rem;margin:0 0 10px">Вариант A — быстро (iPhone Safari)</h2>
<ol>
<li>Откройте мессенджер по <strong>https</strong> (ссылки ниже)</li>
<li>Нажмите <strong>«Подробнее»</strong> / <strong>«Дополнительно»</strong></li>
<li>Нажмите <strong>«Перейти на сайт»</strong></li>
<li>Разрешите микрофон при запросе</li>
</ol>
</div>
<div class="card">
<h2 style="font-size:1.05rem;margin:0 0 10px">Вариант B — убрать предупреждение навсегда</h2>
<ol>
<li>Скачайте сертификат кнопкой ниже</li>
<li><strong>Настройки → Основные → VPN и управление устройством</strong> → установите профиль</li>
<li><strong>Настройки → Основные → Об этом устройстве → Доверие сертификатам</strong> → включите <strong>Messenger Home CA</strong></li>
<li>Откройте мессенджер по https снова</li>
</ol>
<a class="btn" href="/ca.cer">Скачать сертификат доверия</a>
</div>
<div class="card">
<p style="margin:0 0 8px"><strong>Ссылки на мессенджер:</strong></p>
<ul>{https_links}
<li><a href="https://localhost:8000">https://localhost:8000</a> (только с ПК)</li>
</ul>
<p style="margin:12px 0 0;font-size:.85rem">Важно: адрес должен начинаться с <code>https://</code>, не <code>http://</code>.</p>
</div>
</body></html>"""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # quieter
            return

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html", "/trust"):
                data = page.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            elif path in ("/ca.cer", "/cert.cer", "/messenger-ca.cer"):
                if not ca_cer.exists():
                    self.send_error(404)
                    return
                data = ca_cer.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/x-x509-ca-cert")
                self.send_header(
                    "Content-Disposition", 'attachment; filename="messenger-ca.cer"'
                )
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            else:
                self.send_error(404)

    try:
        httpd = ThreadingHTTPServer((host, port), Handler)
    except OSError as e:
        print(f"  Страница доверия не запущена на :{port} ({e})")
        return

    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    print(f"  Инструкция / сертификат → http://localhost:{port}")
    for ip in lan:
        print(f"  На телефоне сначала:     http://{ip}:{port}")


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    trust_port = int(os.environ.get("TRUST_PORT", "8080"))
    # Cloud PaaS / reverse proxy: plain HTTP; TLS is on the platform (real cert, no warnings)
    # Local home LAN: self-signed HTTPS so iPhone mic works
    use_http = (
        IS_CLOUD
        or os.environ.get("USE_HTTP", "").strip().lower() in ("1", "true", "yes")
        or os.environ.get("MESSENGER_CLOUD", "").strip().lower() in ("1", "true", "yes")
    )

    ssl_kwargs: dict[str, Any] = {}
    scheme = "http"
    if not use_http:
        try:
            force = not (DATA / "ca.cer").exists() or not (DATA / "ssl_v2").exists()
            cert_file, key_file = ensure_ssl_certs(force=force)
            ssl_kwargs = {
                "ssl_certfile": str(cert_file),
                "ssl_keyfile": str(key_file),
            }
            scheme = "https"
            start_trust_helper(host, trust_port)
        except Exception as e:
            print(f"  Не удалось включить HTTPS ({e}), запускаю HTTP")
            scheme = "http"

    lan = [ip for ip in _local_ips() if ip not in ("127.0.0.1", "localhost")]
    print(f"\n  Калаграм → {scheme}://localhost:{port}")
    if IS_CLOUD:
        print("  Режим облака: HTTPS даёт хостинг (без предупреждений)")
    for ip in lan:
        print(f"  Телефон (та же Wi‑Fi) → {scheme}://{ip}:{port}")
    if scheme == "https" and not IS_CLOUD:
        print("  Предупреждение «не защищено» — ожидаемо для домашнего сервера.")
        print("  Быстро: Дополнительно → Перейти на сайт")
        print(f"  Или откройте http://<IP>:{trust_port} и установите сертификат\n")
    elif not IS_CLOUD and scheme == "http":
        print("  Внимание: без HTTPS микрофон на телефоне обычно не работает.\n")
    else:
        print()

    uvicorn.run(
        "server:app",
        host=host,
        port=port,
        reload=False,
        proxy_headers=True,
        forwarded_allow_ips="*",
        **ssl_kwargs,
    )
