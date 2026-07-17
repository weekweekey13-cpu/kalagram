"""Web Push (VAPID) for iOS/Android PWA — Apple-compatible."""

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
# Apple accepts mailto: or https: URL
VAPID_EMAIL = os.environ.get(
    "VAPID_MAILTO", "mailto:noreply@kalagram.app"
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
    return pem.decode("ascii") if isinstance(pem, bytes) else str(pem)


def set_vapid_from_pem(priv_pem: str, pub_b64: str | None = None) -> None:
    global _vapid, _public_b64
    pem = priv_pem.replace("\\n", "\n").strip()
    if pem.startswith("-----"):
        _vapid = Vapid.from_pem(pem.encode("utf-8"))
    else:
        # raw urlsafe base64 private scalar
        _vapid = Vapid.from_string(private_key=pem)
    # Always derive public from private so they match for Apple VapidPkHash
    _public_b64 = _pub_b64_from_vapid(_vapid)
    if pub_b64 and pub_b64.strip() != _public_b64:
        print("  Push: WARNING stored public key mismatch — using derived from private")


def ensure_vapid_keys() -> tuple[Any, str]:
    global _vapid, _public_b64
    if _vapid is not None and _public_b64:
        return _vapid, _public_b64

    env_priv = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    if env_priv:
        set_vapid_from_pem(env_priv, os.environ.get("VAPID_PUBLIC_KEY"))
        return _vapid, _public_b64  # type: ignore

    if VAPID_PRIV_FILE.exists():
        pem = VAPID_PRIV_FILE.read_text(encoding="utf-8")
        set_vapid_from_pem(pem)
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
    """Persist VAPID in Neon app_meta; always derive public from private."""
    global _vapid, _public_b64

    env_priv = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    if env_priv:
        set_vapid_from_pem(env_priv, os.environ.get("VAPID_PUBLIC_KEY"))
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

        if priv:
            try:
                set_vapid_from_pem(priv, meta.get("vapid_public"))
                # rewrite public if it was wrong
                async def _upsert(k, val):
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

                await _upsert("vapid_public", _public_b64)
                await db.commit()
                return _vapid, _public_b64  # type: ignore
            except Exception as e:
                print("  Push: bad stored VAPID, regenerating:", e)

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
        # Old device subscriptions used previous keys → wipe
        try:
            await db.execute("DELETE FROM push_subscriptions")
        except Exception:
            pass
        await db.commit()
        _vapid = v
        _public_b64 = pub
        print("  Push: VAPID keys (re)generated — re-enable notifications on phones")
        return _vapid, _public_b64


def _normalize_b64(s: str) -> str:
    """Ensure urlsafe b64 without newlines; keep unpadded for web-push."""
    s = (s or "").strip().replace("-", "+").replace("_", "/")
    # don't convert — pywebpush accepts urlsafe; restore urlsafe
    s = (s or "").strip().replace("+", "-").replace("/", "_").replace("\n", "")
    return s.rstrip("=")


def _send_one(subscription: dict[str, Any], payload: str) -> str:
    from pywebpush import WebPushException, webpush

    vapid, pub = ensure_vapid_keys()
    # normalize keys from DB
    keys = subscription.get("keys") or {}
    sub = {
        "endpoint": subscription["endpoint"],
        "keys": {
            "p256dh": _normalize_b64(keys.get("p256dh", "")),
            "auth": _normalize_b64(keys.get("auth", "")),
        },
    }
    endpoint = str(sub.get("endpoint", ""))[:70]
    try:
        resp = webpush(
            subscription_info=sub,
            data=payload,
            vapid_private_key=vapid,
            vapid_claims={
                "sub": VAPID_EMAIL,
            },
            ttl=86400,
            timeout=30.0,
            verbose=False,
            headers={"Urgency": "high"},
            content_encoding="aes128gcm",
        )
        code = getattr(resp, "status_code", None)
        print(f"push OK {code} {endpoint}")
        return "ok"
    except WebPushException as e:
        status = None
        body = ""
        try:
            status = e.response.status_code  # type: ignore[union-attr]
            body = (e.response.text or "")[:500]  # type: ignore[union-attr]
        except Exception:
            body = str(e)
        print(f"push FAIL {status} {endpoint} :: {body}")
        if status in (404, 410):
            return "gone"
        # common apple: VapidPkHashMismatch when phone subscribed with other key
        if body and "Vapid" in body or "vapid" in body.lower() or status == 400:
            return f"err:{status or 400}:{body[:120] or e}"
        return f"err:{status or e}"
    except Exception as e:
        print(f"push EXC {endpoint} {e}")
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
            "title": (title or "Калаграм")[:64],
            "body": (body or "Новое сообщение")[:180],
            "data": data or {},
            "icon": "/static/icons/icon-192.png",
            "badge": "/static/icons/icon-192.png",
        },
        ensure_ascii=False,
    )
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _send_one, subscription, payload)
