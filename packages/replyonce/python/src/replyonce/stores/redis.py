"""Redis store on ``redis.asyncio``. Same key layout and scripts as the TypeScript ``RedisStore``."""

from __future__ import annotations

import asyncio
import json
import random
from typing import Any, Callable, Optional

_READ = "return redis.call('HMGET', KEYS[1], 's', 'v')"

_CAS = """
local v = tonumber(redis.call('HGET', KEYS[1], 'v') or '0')
if v ~= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 's', ARGV[2], 'v', v + 1)
local ttl = tonumber(ARGV[3])
if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1
"""


class StoreContentionError(Exception):
    pass


def _text(v: Any) -> Optional[str]:
    if v is None:
        return None
    return v.decode("utf-8") if isinstance(v, bytes) else str(v)


class RedisStore:
    """One hash per scope holding the state and a version, written by compare-and-set."""

    def __init__(self, client: Any, prefix: str = "replyonce", key_ttl_ms: int = 30 * 24 * 3_600_000, max_retries: int = 200) -> None:
        if client is None:
            raise TypeError("replyonce: RedisStore needs a client")
        self._client = client
        self._prefix = prefix
        self._ttl = key_ttl_ms
        self._max_retries = max_retries

    def _key(self, scope: str) -> str:
        return f"{self._prefix}:{{{scope}}}"

    async def _load(self, scope: str) -> tuple[Optional[dict], int]:
        reply = await self._client.eval(_READ, 1, self._key(scope))
        raw = _text(reply[0]) if reply else None
        version = int(_text(reply[1])) if reply and reply[1] is not None else 0
        return (json.loads(raw) if raw else None), version

    async def read(self, scope: str) -> Optional[dict]:
        return (await self._load(scope))[0]

    async def transact(self, scope: str, fn: Callable[[Optional[dict]], tuple[Optional[dict], Any]]) -> Any:
        key = self._key(scope)
        for attempt in range(self._max_retries + 1):
            state, version = await self._load(scope)
            nxt, result = fn(state)
            if nxt is None:
                return result
            ok = await self._client.eval(_CAS, 1, key, version, json.dumps(nxt), self._ttl)
            if int(ok) == 1:
                return result
            await asyncio.sleep(random.random() * min(50, 2 ** min(attempt, 6)) / 1000)
        raise StoreContentionError(f"replyonce: gave up on scope {scope!r} after {self._max_retries + 1} contended attempts")
