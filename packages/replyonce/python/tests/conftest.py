from __future__ import annotations

import asyncio
import os
import sys
import uuid
from contextlib import asynccontextmanager

import pytest

from replyonce import MemoryStore

PG_URL = os.environ.get("REPLYONCE_PG_URL")
REDIS_URL = os.environ.get("REPLYONCE_REDIS_URL")

STORES = ["memory"] + (["postgres"] if PG_URL else []) + (["redis"] if REDIS_URL else [])


@asynccontextmanager
async def open_store(kind: str):
    if kind == "memory":
        yield MemoryStore()
    elif kind == "postgres":
        from psycopg_pool import AsyncConnectionPool

        from replyonce.stores.postgres import PostgresStore

        pool = AsyncConnectionPool(PG_URL, min_size=1, max_size=40, open=False)
        await pool.open()
        try:
            store = PostgresStore(pool, table="replyonce_test_scopes_py")
            await store.migrate()
            yield store
        finally:
            await pool.close()
    else:
        import redis.asyncio as redis

        from replyonce.stores.redis import RedisStore

        client = redis.Redis(connection_pool=redis.BlockingConnectionPool.from_url(REDIS_URL, max_connections=50))
        try:
            yield RedisStore(client, prefix=f"replyonce-pytest-{uuid.uuid4().hex[:8]}")
        finally:
            await client.aclose()


def arun(coro):
    """Run a coroutine on a loop psycopg can use on every platform."""
    if sys.platform == "win32":
        if sys.version_info >= (3, 12):
            return asyncio.run(coro, loop_factory=asyncio.SelectorEventLoop)
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())  # pragma: no cover
    return asyncio.run(coro)


@pytest.fixture(params=STORES)
def with_store(request):
    """Call ``with_store(body)`` where ``body(store)`` is an async test body."""

    def runner(body):
        async def main():
            async with open_store(request.param) as store:
                await body(store)

        arun(main())

    runner.kind = request.param
    return runner


def uid(prefix: str = "conv") -> str:
    return f"{prefix}-{uuid.uuid4()}"


async def until(cond, timeout: float = 5.0) -> None:
    """Wait until ``cond()`` holds. A fixed sleep is not enough for a store round trip on a slow runner."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not cond():
        if loop.time() > deadline:
            raise AssertionError("until: condition not met in time")
        await asyncio.sleep(0.002)


class FakeClock:
    def __init__(self, start: int = 1_800_000_000_000) -> None:
        self.t = start

    def __call__(self) -> int:
        return self.t

    def advance(self, ms: int) -> None:
        self.t += ms
