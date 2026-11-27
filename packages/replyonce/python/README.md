# replyonce (Python)

**Stop your agent from replying, refunding or ticketing twice.**

The Python port of [replyonce](https://github.com/shmindmaster/replyonce). It uses the same
state machine and stores the same JSON state as the TypeScript package, so Python and
Node workers can share one Postgres table or Redis prefix. The full guide, design notes,
guarantees and limits are in the [main README](https://github.com/shmindmaster/replyonce#readme).

```sh
pip install replyonce            # memory store
pip install "replyonce[postgres]" # + psycopg 3
pip install "replyonce[redis]"    # + redis-py
replyonce demo                    # chaos simulation: duplicates without vs with replyonce
```

## 30-second quickstart

```python
import asyncio
from replyonce import Key, MemoryStore, ReplyOnce

ro = ReplyOnce(MemoryStore())  # PostgresStore / RedisStore in production
refunds_issued = 0

async def issue_refund(ctx):
    # Your provider call goes here; pass ctx.idempotency_key if it accepts one.
    global refunds_issued
    refunds_issued += 1
    return {"refund_id": "re_1"}

async def main():
    key = Key("order-A-1001", "refund", {"order": "A-1001", "cents": 2500})
    raced = await asyncio.gather(*(ro.once(key, issue_refund) for _ in range(3)))
    late = await ro.once(key, issue_refund)
    print([r.status for r in raced])  # ['executed', 'in_flight', 'in_flight']
    print(late.status, late.value)    # replayed {'refund_id': 're_1'}
    print(refunds_issued)             # 1

asyncio.run(main())
```

A conversational agent opens a run per unit of work and sends every customer-visible
write through it:

```python
run = await ro.begin(conversation_id, run_id=job_id, context_at=snapshot_ms)
if run.can_write:
    r = await run.once("reply", {"in_reply_to": message_id}, send_reply, summary=text)
    if r.status == "refused" and r.reason == "conversation_changed":
        ...  # r.conflicts says what another run did; re-read and decide again
    await run.end()
```

## Stores

```python
from psycopg_pool import AsyncConnectionPool
from replyonce.stores.postgres import PostgresStore
store = PostgresStore(AsyncConnectionPool(dsn, open=False))  # await pool.open(); await store.migrate()

import redis.asyncio as redis
from replyonce.stores.redis import RedisStore
# A blocking pool waits for a free connection under bursts instead of raising "Too many connections".
store = RedisStore(redis.Redis(connection_pool=redis.BlockingConnectionPool.from_url(url, max_connections=50)))
```

## Adapters

`replyonce.adapters` has `guard_tool`, `check_tool`, `dispatch_tool`, `describe_outcome`,
`to_openai_tool`, `to_anthropic_tool`, `webhook_once` and `http_status_for`. They behave as
the TypeScript adapters do. The BullMQ adapter is Node-only.

## Differences from the TypeScript package

- The API is asyncio-only.
- Names are snake_case (`pending_ttl_ms`, `run_id`, `context_at`). Results are dataclasses, and
  ledger entries are plain dicts with the shared camelCase field names.
- The effect gets `ctx.deadline_ms` (epoch ms) instead of an `AbortSignal`.

Apache-2.0.
