# API

The full reference, with examples, is the [README](../README.md#api). This page
is the map.

| Import | Exports |
| --- | --- |
| `replyonce` | `createReplyOnce`, `ReplyOnce`, `Run`, `MemoryStore`, `NotApplied`, `ReplyOnceError`, `defaultClassifyError`, `unwrap`, key helpers (`effectKey`, `hashPayload`, `providerIdempotencyKey`, `canonicalJson`) |
| `replyonce/postgres` | `PostgresStore`, `postgresSchemaSql` |
| `replyonce/redis` | `RedisStore`, `StoreContentionError` |
| `replyonce/adapters` | `guardTool`, `checkTool`, `dispatchTool`, `describeOutcome`, `toOpenAITool`, `toAnthropicTool`, `webhookOnce`, `httpStatusFor`, `onceProcessor`, `ScopeBusyError` |

`ro.once({ scope, intent, payload }, fn)` applies the effect at most once for
that business identity. A race returns `executed` for the winner and
`in_flight` or `replayed` for the rest. A call whose `fn` threw `NotApplied`
or a retryable error is `failed`, and a later call with the same key runs `fn`
again.

A conversational run (`ro.begin(scope, { runId, contextAt })`) is one inbound
message or one queue job. Customer-visible writes go through `run.once`. The
run refuses the write when its fencing token is stale or when another run's
write is pending, or landed after this run read the conversation.

## Results

Every `once` returns a result instead of throwing. Store outages throw, and so
do invalid keys (an empty scope or a circular payload), before the store is touched.

| `status` | Meaning |
| --- | --- |
| `executed` | Ran now. |
| `replayed` | Already committed. The stored value is returned. |
| `in_flight` | Another attempt is pending. |
| `ambiguous` | The outcome is unknown. Reconcile or resolve; do not repeat. |
| `failed` | Known not applied. Retry when `retryable`. |
| `refused` | `reason` is `superseded`, `run_cancelled`, `run_ended`, `busy`, `conversation_changed`, or `exhausted`. |

`onceProcessor` (BullMQ) returns a `Skipped` value instead of running the
processor. Its `reason` is `ended`, `superseded`, or `redelivered_after_write`.

`httpStatusFor` maps a result for webhook providers: `executed` and `replayed`
are `200`, `in_flight` is `503` with `Retry-After: 5`, a retryable `failed` is
`500`, and everything else is `200`, because redelivery cannot resolve it.

## Python

`replyonce` on PyPI (import `replyonce`, Python 3.10+). The API mirrors the
TypeScript one in snake_case and is asyncio-only. Stores are
`replyonce.stores.postgres` and `replyonce.stores.redis`, behind the
`postgres` and `redis` extras. `replyonce.adapters` has every adapter except
BullMQ. See [python/README.md](../python/README.md).

## CLI

`replyonce demo [--conversations N] [--seed N]` (Node: `npx replyonce demo`
or `node dist/cli.js demo` after a build; Python: `replyonce demo`). The
defaults are 100 conversations and seed 7. The Node CLI colours its output on a
terminal: `FORCE_COLOR=1` keeps the colours when piped, `FORCE_COLOR=0` turns
them off, and `NO_COLOR` turns them off when `FORCE_COLOR` is unset. The Python
CLI prints plain text.
