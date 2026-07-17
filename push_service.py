"""Web Push (VAPID) for iOS/Android PWA notifications."""

from __future__ import annotations

import asyncio
import base64
import json
import os
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("DATA_DIR", str(ROOT / "data"))).resolve()
DATA.mkdir(parents=True, exist_ok=True)

VAPID_PRIV_FILE = DATA / "vapid_private.pem"
VAPID_PUB_FILE = DATA / "vapid_public.b64"
VAPID_EMAIL = os.environ.get("VAPID_MAILTO", "mailto:kalagram@local")

_private_pem: str | None = None
_public_b64: str | None = None


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _generate_pair() -> tuple[str, str]:
    key = ec.generate_private_key(ec.SECP256R1())
    priv_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    pub_bytes = key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return priv_pem, _b64url(pub_bytes)


def ensure_vapid_keys() -> tuple[str, str]:
    """Return (private_pem, public_application_server_key_b64url). Sync, file/env only."""
    global _private_pem, _public_b64
    if _private_pem and _public_b64:
        return _private_pem, _public_b64

    env_priv = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    env_pub = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
    if env_priv and env_pub:
        _private_pem = env_priv.replace("\\n", "\n")
        _public_b64 = env_pub
        return _private_pem, _public_b64

    if VAPID_PRIV_FILE.exists() and VAPID_PUB_FILE.exists():
        _private_pem = VAPID_PRIV_FILE.read_text(encoding="utf-8")
        _public_b64 = VAPID_PUB_FILE.read_text(encoding="utf-8").strip()
        return _private_pem, _public_b64

    priv_pem, pub_b64 = _generate_pair()
    try:
        VAPID_PRIV_FILE.write_text(priv_pem, encoding="utf-8")
        VAPID_PUB_FILE.write_text(pub_b64, encoding="utf-8")
    except OSError:
        pass
    _private_pem = priv_pem
    _public_b64 = pub_b64
    return _private_pem, _public_b64


def set_vapid_keys(priv_pem: str, pub_b64: str) -> None:
    global _private_pem, _public_b64
    _private_pem = priv_pem
    _public_b64 = pub_b64


def public_key() -> str:
    return ensure_vapid_keys()[1]


async def ensure_vapid_keys_db(connect_fn, db_path) -> tuple[str, str]:
    """Load/save VAPID in app_meta so keys survive Render restarts (with Neon)."""
    global _private_pem, _public_b64
    # env wins
    env_priv = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    env_pub = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
    if env_priv and env_pub:
        set_vapid_keys(env_priv.replace("\\n", "\n"), env_pub)
        return _private_pem, _public_b64

    import aiosqlite

    async with connect_fn(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT key, value FROM app_meta WHERE key IN ('vapid_private', 'vapid_public')"
        )
        rows = await cur.fetchall()
        meta = {r["key"]: r["value"] for r in rows}
        if meta.get("vapid_private") and meta.get("vapid_public"):
            set_vapid_keys(meta["vapid_private"], meta["vapid_public"])
            return _private_pem, _public_b64

        priv_pem, pub_b64 = _generate_pair()
        # try file cache too
        try:
            VAPID_PRIV_FILE.write_text(priv_pem, encoding="utf-8")
            VAPID_PUB_FILE.write_text(pub_b64, encoding="utf-8")
        except OSError:
            pass
        for k, v in (("vapid_private", priv_pem), ("vapid_public", pub_b64)):
            if hasattr(db, "pg") and getattr(db, "pg", False):
                await db.execute(
                    "INSERT INTO app_meta (key, value) VALUES (?, ?) "
                    "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                    (k, v),
                )
            else:
                await db.execute("DELETE FROM app_meta WHERE key = ?", (k,))
                await db.execute(
                    "INSERT INTO app_meta (key, value) VALUES (?, ?)", (k, v)
                )
        await db.commit()
        set_vapid_keys(priv_pem, pub_b64)
        return priv_pem, pub_b64


def _send_one(subscription: dict[str, Any], payload: str) -> str | None:
    """Returns 'ok', 'gone', or error string."""
    from pywebpush import WebPushException, webpush

    priv, _ = ensure_vapid_keys()
    try:
        webpush(
            subscription_info=subscription,
            data=payload,
            vapid_private_key=priv,
            vapid_claims={"sub": VAPID_EMAIL},
            ttl=60,
        )
        return "ok"
    except WebPushException as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        if status in (404, 410):
            return "gone"
        return f"err:{status or e}"
    except Exception as e:
        return f"err:{e}"


async def send_web_push(
    subscription: dict[str, Any],
    title: str,
    body: str,
    data: dict[str, Any] | None = None,
) -> str:
    payload = json.dumps(
        {
            "title": title,
            "body": body,
            "data": data or {},
            "icon": "/static/icons/icon-192.png",
            "badge": "/static/icons/icon-192.png",
        },
        ensure_ascii=False,
    )
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _send_one, subscription, payload)
