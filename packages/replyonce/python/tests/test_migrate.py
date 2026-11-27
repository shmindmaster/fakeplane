from __future__ import annotations

import asyncio
import uuid

import pytest

from .conftest import PG_URL, arun


@pytest.mark.skipif(not PG_URL, reason="needs REPLYONCE_PG_URL")
def test_many_workers_migrate_the_same_fresh_table_at_once():
    from psycopg_pool import AsyncConnectionPool

    from replyonce.stores.postgres import PostgresStore

    async def main():
        table = f"replyonce_migrate_py_{uuid.uuid4().hex[:12]}"
        pool = AsyncConnectionPool(PG_URL, min_size=1, max_size=20, open=False)
        await pool.open()
        try:
            workers = [PostgresStore(pool, table=table) for _ in range(10)]
            await asyncio.gather(*(w.migrate() for w in workers))
            await workers[0].transact("scope", lambda state: ({"effects": {}}, None))
            assert await workers[1].read("scope") is not None
        finally:
            async with pool.connection() as conn:
                await conn.execute(f'DROP TABLE IF EXISTS "{table}"')
            await pool.close()

    arun(main())
