# Integrations

replyonce has no runtime dependencies. Each store takes a client you
construct, so the driver is your choice and your version.

| Integration | Role |
| --- | --- |
| Postgres | Shared store. Node takes a `pg.Pool`-like client (`query`, `connect`). Python takes a `psycopg_pool.AsyncConnectionPool` (`replyonce[postgres]`). |
| Redis | Shared store. Node takes an `eval`-capable client such as `ioredis`; node-redis works with an `eval` shim. Python takes `redis.asyncio` (`replyonce[redis]`); use a `BlockingConnectionPool` under bursts. |
| BullMQ | Node only. `onceProcessor` makes each job a run keyed by queue name and job id. Retries and stalled-job redelivery resume the run and replay completed effects. `onRedeliveredAfterWrite: 'skip'` skips a job whose earlier delivery claimed a write that is pending, committed or ambiguous, so a skip does not prove the effect was delivered. |
| Webhooks | `webhookOnce` keys a delivery by `scope`, `intent` (default `webhook`) and `eventId`, so keep scope and intent fixed per provider. It suggests the HTTP status (`503` with `Retry-After` while a duplicate is in flight). |
| Tool calls | `guardTool` and `checkTool` produce OpenAI (Chat Completions and Responses) and Anthropic tool shapes. `identity(args)` picks the business fields; the key is never the tool-call id. |
| Providers | The effect gets `ctx.idempotencyKey`, stable across attempts and workers. Pass it to providers that accept one. |

Environment variables are read by the test suites, the examples, and the
interop scripts, not by the library:

| Variable | Read by |
| --- | --- |
| `REPLYONCE_PG_URL` | Node and Python suites, both interop scripts |
| `REPLYONCE_REDIS_URL` | Node and Python suites, both interop scripts |
| `DATABASE_URL` | `examples/postgres.ts` |
| `REDIS_URL` | `examples/bullmq-worker.ts` |

Compose sets all four to its `postgres` and `redis` services. A host shell
does not need them.
