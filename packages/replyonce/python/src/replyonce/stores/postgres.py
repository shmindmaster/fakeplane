"""Postgres store on psycopg 3 (async). Same table layout as the TypeScript ``PostgresStore``."""

from __future__ import annotations

import json
import re
from typing import Any, Callable, Optional

_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


def _quote_table(table: str) -> str:
    parts = table.split(".")
    if len(parts) > 2 or not all(_IDENT.match(p) for p in parts):
        raise TypeError(f"replyonce: invalid table name {table!r}")
    return ".".join(f'"{p}"' for p in parts)


def postgres_schema_sql(table: str = "replyonce_scopes") -> str:
    t = _quote_table(table)
    return (
        f"CREATE TABLE IF NOT EXISTS {t} (\n"
        "  scope text PRIMARY KEY,\n"
        "  state jsonb NOT NULL,\n"
        "  version bigint NOT NULL DEFAULT 0,\n"
        "  updated_at timestamptz NOT NULL DEFAULT now()\n"
        ");"
    )


def _state(value: Any) -> Optional[dict]:
    if value is None:
        return None
    return json.loads(value) if isinstance(value, (str, bytes)) else value


class PostgresStore:
    """Each operation is one transaction holding the scope row's lock (``SELECT ... FOR UPDATE``).

    ``pool`` is a ``psycopg_pool.AsyncConnectionPool`` (anything whose ``connection()`` is an
    async context manager yielding a psycopg ``AsyncConnection``).
    """

    def __init__(self, pool: Any, table: str = "replyonce_scopes") -> None:
        if pool is None:
            raise TypeError("replyonce: PostgresStore needs a pool")
        self._pool = pool
        self.table_name = table
        self._t = _quote_table(table)

    async def migrate(self) -> None:
        """Create the table if needed. Safe from several workers at once: concurrent
        ``CREATE TABLE IF NOT EXISTS`` can fail on the catalog's unique index, so migrations
        of the same table are serialized with a transaction-scoped advisory lock."""
        async with self._pool.connection() as conn:
            async with conn.transaction():
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s))", (f"replyonce:migrate:{self.table_name}",)
                )
                await conn.execute(postgres_schema_sql(self.table_name))

    async def read(self, scope: str) -> Optional[dict]:
        async with self._pool.connection() as conn:
            cur = await conn.execute(f"SELECT state FROM {self._t} WHERE scope = %s", (scope,))
            row = await cur.fetchone()
            return _state(row[0]) if row else None

    async def transact(self, scope: str, fn: Callable[[Optional[dict]], tuple[Optional[dict], Any]]) -> Any:
        select = f"SELECT state FROM {self._t} WHERE scope = %s FOR UPDATE"
        update = f"UPDATE {self._t} SET state = %s::jsonb, version = version + 1, updated_at = now() WHERE scope = %s"
        async with self._pool.connection() as conn:
            async with conn.transaction():
                cur = await conn.execute(select, (scope,))
                row = await cur.fetchone()
                nxt, result = fn(_state(row[0]) if row else None)
                if nxt is None:
                    return result
                if row:
                    await conn.execute(update, (json.dumps(nxt), scope))
                    return result
                cur = await conn.execute(
                    f"INSERT INTO {self._t} (scope, state) VALUES (%s, %s::jsonb) ON CONFLICT (scope) DO NOTHING RETURNING scope",
                    (scope, json.dumps(nxt)),
                )
                if await cur.fetchone():
                    return result
                # Another transaction created the scope first: decide again under its lock.
                cur = await conn.execute(select, (scope,))
                row = await cur.fetchone()
                nxt, result = fn(_state(row[0]) if row else None)
                if nxt is not None:
                    await conn.execute(update, (json.dumps(nxt), scope))
                return result

    async def purge(self, older_than_ms: int) -> int:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"DELETE FROM {self._t} WHERE updated_at < now() - (%s * interval '1 millisecond')", (older_than_ms,)
            )
            return cur.rowcount or 0
