"""Web Push (VAPID) — iOS/Android PWA. Uses py_vapid key format pywebpush expects."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import traceback
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("DATA_DIR", str(ROOT / "data"))).resolve()
DATA.mkdir(parents=True, exist_ok=True)

VAPID_PRIV_FILE = DATA / "vapid_private.pem"
VAPID_PUB_FILE = DATA / "vapid_public.b64"
VAPID_EMAIL = os.environ.get(
    "VAPID_MAILTO", "mailto:noreply@kalagram-z20h.onrender.com"
)

_vapid: Vapid | None = None
_public_b64: str | None = None


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _pub_b64_from_vapid(v: Vapid) -> str:
    raw = v.public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return _b64url(raw)


def _pem_str(v: Vapid) -> str:
    pem = v.private_pem()
    if isinstance(pem, bytes):
        return pem.decode("ascii")
    return str(pem)


def set_vapid_from_pem(priv_pem: str, pub_b64: str | None = None) -> None:
    global _vapid, _public_b64
    pem = priv_pem.replace("\\n", "\n").strip()
    if not pem.startswith("-----"):
        # raw 32-byte key as b64
        _vapid = Vapid.from_string(private_key=pem)
    else:
        _vapid = Vapid.from_pem(pem.encode("ascii") if isinstance(pem, str) else pem)
    _public_b64 = pub_b64 or _pub_b64_from_vapid(_vapid)


def ensure_vapid_keys() -> tuple[Any, str]:
    """Return (Vapid instance, public_applicationServerKey_b64url)."""
    global _vapid, _public_b64
    if _vapid is not None and _public_b64:
        return _vapid, _public_b64

    env_priv = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    env_pub = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
    if env_priv:
        set_vapid_from_pem(env_priv, env_pub or None)
        return _vapid, _public_b64  # type: ignore

    if VAPID_PRIV_FILE.exists():
        pem = VAPID_PRIV_FILE.read_text(encoding="utf-8")
        pub = VAPID_PUB_FILE.read_text(encoding="utf-8").strip() if VAPID_PUB_FILE.exists() else None
        set_vapid_from_pem(pem, pub)
        return _vapid, _public_b64  # type: ignore

    v = Vapid()
    v.generate_keys()
    pem = _pem_str(v)
    pub = _pub_b64_from_vapid(v)
    try:
        VAPID_PRIV_FILE.write_text(pem, encoding="utf-8")
        VAPID_PUB_FILE.write_text(pub, encoding="utf-8")
    except OSError:
        pass
    _vapid = v
    _public_b64 = pub
    return _vapid, _public_b64


def public_key() -> str:
    return ensure_vapid_keys()[1]


async def ensure_vapid_keys_db(connect_fn, db_path) -> tuple[Any, str]:
    """Load/save VAPID PEM in app_meta so keys survive Render restarts (Neon)."""
    global _vapid, _public_b64

    env_priv = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    env_pub = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
    if env_priv:
        set_vapid_from_pem(env_priv, env_pub or None)
        return _vapid, _public_b64  # type: ignore

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

        # Accept PEM or raw; regenerate if missing
        if priv and pub and len(pub) >= 80:
            try:
                set_vapid_from_pem(priv, pub)
                return _vapid, _public_b64  # type: ignore
            except Exception as e:
                print("  Push: stored VAPID invalid, regenerating:", e)

        v = Vapid()
        v.generate_keys()
        pem = _pem_str(v)
        pub = _pub_b64_from_vapid(v)
        try:
            VAPID_PRIV_FILE.write_text(pem, encoding="utf-8")
            VAPID_PUB_FILE.write_text(pub, encoding="utf-8")
        except OSError:
            pass

        for k, val in (("vapid_private", pem), ("vapid_public", pub)):
            if getattr(db, "pg", False):
                await db.execute(
                    "INSERT INTO app_meta (key, value) VALUES (?, ?) "
                    "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                    (k, val),
                )
            else:
                await db.execute("DELETE FROM app_meta WHERE key = ?", (k,))
                await db.execute(
                    "INSERT INTO app_meta (key, value) VALUES (?, ?)", (k, val)
                )
        await db.commit()
        _vapid = v
        _public_b64 = pub
        print("  Push: new VAPID keys saved — devices must re-enable notifications")
        return _vapid, _public_b64


def _send_one(subscription: dict[str, Any], payload: str) -> str:
    from pywebpush import WebPushException, webpush

    vapid, _ = ensure_vapid_keys()
    endpoint = str(subscription.get("endpoint", ""))[:60]
    try:
        # claims: sub must be mailto: or https:
        claims = {"sub": VAPID_EMAIL}
        resp = webpush(
            subscription_info=subscription,
            data=payload,
            vapid_private_key=vapid,  # Vapid instance
            vapid_claims=claims,
            ttl=86400,
            timeout=30.0,
            verbose=True,
            headers={"Urgency": "high"},
            content_encoding="aes128gcm",
        )
        code = getattr(resp, "status_code", None)
        print(f"push OK status={code} ep={endpoint}")
        return "ok"
    except WebPushException as e:
        status = None
        body = ""
        try:
            status = e.response.status_code  # type: ignore[union-attr]
            body = (e.response.text or "")[:400]  # type: ignore[union-attr]
        except Exception:
            pass
        print(f"push FAIL status={status} ep={endpoint} err={e} body={body}")
        if status in (404, 410):
            return "gone"
        return f"err:{status or e}"
    except Exception as e:
        print(f"push EXC ep={endpoint} {e}")
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
            "title": (title or "Калаграм")[:80],
            "body": (body or "Новое сообщение")[:200],
            "data": data or {},
            "icon": "/static/icons/icon-192.png",
            "badge": "/static/icons/icon-192.png",
        },
        ensure_ascii=False,
    )
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _send_one, subscription, payload)
