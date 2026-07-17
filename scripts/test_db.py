import asyncio
from pathlib import Path

from db import USE_PG, connect, init_schema, load_media, save_media
import aiosqlite

DB = Path(__file__).resolve().parents[1] / "data" / "messenger.db"


async def main():
    await init_schema(DB)
    async with connect(DB) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT nick FROM users LIMIT 3")
        rows = await cur.fetchall()
        print("users", [r["nick"] for r in rows])
    await save_media("test.bin", "text/plain", b"hello", DB)
    print("media", await load_media("test.bin", DB))
    print("USE_PG", USE_PG)
    import server  # noqa: F401

    print("server import ok")


if __name__ == "__main__":
    asyncio.run(main())
