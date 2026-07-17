"""Web Push (VAPID) for iOS/Android PWA notifications."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import traceback
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("DATA_DIR", str(ROOT / "data"))).resolve()
DATA.mkdir(parents=True, exist_ok=True)

VAPID_PRIV_FILE = DATA / "vapid_private.b64"
VAPID_PUB_FILE = DATA / "vapid_public.b64"
# Apple/WebPush prefers a real-looking mailto
VAPID_EMAIL = os.environ.get(
    "VAPID_MAILTO", "mailto:noreply@kalagram-z20h.onrender.com"
)

# raw urlsafe base64 (no padding): 32-byte private scalar + 65-byte uncompressed public
_private_b64: str | None = None
_public_b64: str | None = None


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def _generate_pair() -> tuple[str, str]:
    """Return (private_raw_b64url, public_uncompressed_b64url) for pywebpush + browser."""
    key = ec.generate_private_key(ec.SECP256R1())
    priv_num = key.private_numbers().private_value
    priv_bytes = priv_num.to_bytes(32, "big")
    pub_bytes = key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return _b64url(priv_bytes), _b64url(pub_bytes)


def set_vapid_keys(priv_b64: str, pub_b64: str) -> None:
    global _private_b64, _public_b64
    _private_b64 = priv_b64.strip()
    _public_b64 = pub_b64.strip()


def ensure_vapid_keys() -> tuple[str, str]:
    global _private_b64, _public_b64
    if _private_b64 and _public_b64:
        return _private_b64, _public_b64

    env_priv = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    env_pub = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
    if env_priv and env_pub:
        # accept raw b64; if PEM passed, try extract later in send
        set_vapid_keys(env_priv.replace("\\n", "\n"), env_pub)
        return _private_b64, _public_b64

    if VAPID_PRIV_FILE.exists() and VAPID_PUB_FILE.exists():
        set_vapid_keys(
            VAPID_PRIV_FILE.read_text(encoding="utf-8"),
            VAPID_PUB_FILE.read_text(encoding="utf-8"),
        )
        return _private_b64, _public_b64

    priv_b64, pub_b64 = _generate_pair()
    try:
        VAPID_PRIV_FILE.write_text(priv_b64, encoding="utf-8")
        VAPID_PUB_FILE.write_text(pub_b64, encoding="utf-8")
    except OSError:
        pass
    set_vapid_keys(priv_b64, pub_b64)
    return _private_b64, _public_b64


def public_key() -> str:
    return ensure_vapid_keys()[1]


async def ensure_vapid_keys_db(connect_fn, db_path) -> tuple[str, str]:
    """Persist VAPID in app_meta (Neon) so keys survive Render restarts."""
    global _private_b64, _public_b64

    env_priv = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    env_pub = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
    if env_priv and env_pub:
        set_vapid_keys(env_priv.replace("\\n", "\n"), env_pub)
        return _private_b64, _public_b64

    import aiosqlite

    async with connect_fn(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT key, value FROM app_meta WHERE key IN ('vapid_private', 'vapid_public')"
        )
        rows = await cur.fetchall()
        meta = {r["key"]: r["value"] for r in rows}

        priv = meta.get("vapid_private") or ""
        pub = meta.get("vapid_public") or ""
        # Use stored raw keys; reject old PEM format
        if priv and pub and not priv.startswith("-----BEGIN") and len(pub) >= 80:
            set_vapid_keys(priv, pub)
            return _private_b64, _public_b64

        priv_b64, pub_b64 = _generate_pair()
        try:
            VAPID_PRIV_FILE.write_text(priv_b64, encoding="utf-8")
            VAPID_PUB_FILE.write_text(pub_b64, encoding="utf-8")
        except OSError:
            pass

        for k, v in (("vapid_private", priv_b64), ("vapid_public", pub_b64)):
            if getattr(db, "pg", False):
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
        set_vapid_keys(priv_b64, pub_b64)
        print("  Push: generated new VAPID keys (re-enable notifications on devices)")
        return priv_b64, pub_b64


def _send_one(subscription: dict[str, Any], payload: str) -> str:
    """Returns 'ok', 'gone', or 'err:...'."""
    from pywebpush import WebPushException, webpush

    priv, _ = ensure_vapid_keys()
    # pywebpush accepts raw urlsafe base64 private key (32 bytes)
    try:
        resp = webpush(
            subscription_info=subscription,
            data=payload.encode("utf-8") if isinstance(payload, str) else payload,
            vapid_private_key=priv,
            vapid_claims={"sub": VAPID_EMAIL},
            ttl=86400,
            headers={"Urgency": "high", "Topic": "kalagram"},
        )
        print("push ok", getattr(resp, "status_code", "?"), subscription.get("endpoint", "")[:48])
        return "ok"
    except WebPushException as e:
        status = None
        try:
            status = e.response.status_code  # type: ignore
        except Exception:
            pass
        print("push WebPushException", status, e)
        if status in (404, 410):
            return "gone"
        # include body for debug
        try:
            body = e.response.text  # type: ignore
            print("push body", body[:300] if body else "")
        except Exception:
            pass
        return f"err:{status or e}"
    except Exception as e:
        print("push Exception", e)
        traceback.print_exc()
        return f"err:{e}"


async def send_web_push(
    subscription: dict[str, Any],
    title: str,
    body: str,
    data: dict[str, Any] | None = None,
) -> str:
    payload = json.dumps(
        {
            "title": title[:64] or "Калаграм",
            "body": (body or "Новое сообщение")[:180],
            "data": data or {},
            "icon": "/static/icons/icon-192.png",
            "badge": "/static/icons/icon-192.png",
        },
        ensure_ascii=False,
    )
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _send_one, subscription, payload)
