"""Phase 2 of the cross-language check (see scripts/interop.ts in the repo root)."""

import asyncio
import os
import sys

import redis.asyncio as redis
from psycopg_pool import AsyncConnectionPool

from replyonce import Key, ReplyOnce
from replyonce.stores.postgres import PostgresStore
from replyonce.stores.redis import RedisStore


async def check(name, store, scope):
    ro = ReplyOnce(store)
    refund = Key(scope, "refund", {"order": "A-1001", "cents": 2500})
    replayed = await ro.once(refund, lambda ctx: {"refundId": "re_from_python"})
    assert (replayed.status, replayed.value) == ("replayed", {"refundId": "re_from_ts"}), replayed
    run = await ro.begin(scope, run_id="py-run")
    assert run.state == "new", run.state
    reply = await run.once("reply", {"inReplyTo": "m1"}, lambda ctx: {"messageId": "from_python"})
    assert reply.status == "executed", reply
    print(f"interop phase 2 ok on {name}")


async def main(scope):
    pool = AsyncConnectionPool(os.environ["REPLYONCE_PG_URL"], open=False)
    await pool.open()
    client = redis.from_url(os.environ.get("REPLYONCE_REDIS_URL", "redis://localhost:6379"))
    try:
        await check("postgres", PostgresStore(pool, table="replyonce_interop"), scope)
        await check("redis", RedisStore(client, prefix="replyonce-interop"), scope)
    finally:
        await pool.close()
        await client.aclose()


if __name__ == "__main__":
    if sys.platform == "win32" and sys.version_info >= (3, 12):
        asyncio.run(main(sys.argv[1]), loop_factory=asyncio.SelectorEventLoop)
    else:
        asyncio.run(main(sys.argv[1]))
