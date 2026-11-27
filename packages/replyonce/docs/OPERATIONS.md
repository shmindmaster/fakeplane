# Operations

## Demo

Inside the Node image, after `npm run build`:

```text
node dist/cli.js demo --conversations 100 --seed 7
```

A duplicate reply fails the demo. That is the production signal the library
exists to prevent. The Python image runs `uv run replyonce demo`.

## Local databases

`docker compose down` stops Postgres and Redis. Their data is not a named
volume in this project, so it does not accumulate. Do not point compose at
a database that holds real customer effects.

## Image cleanup

Tags are `replyonce-node:local` and `replyonce-python:local`. Remove them
with `docker image rm` when you want the disk back. Do not prune volumes
that belong to another compose project.

## When a write is refused

| Result | What it means | What to do |
| --- | --- | --- |
| `replayed` | The effect already happened. | Use the stored value. Do not tell the customer twice. |
| `in_flight` | Another attempt is pending. | Nothing, or pass `wait`. |
| `refused: superseded` | A newer run owns the conversation, or a later delivery owns the run. | Stop this run. |
| `refused: run_ended`, `run_cancelled` | The run is closed. | Stop. |
| `refused: conversation_changed` | Another run wrote, or is writing, after this run read. | Re-read the conversation, then decide again. |
| `refused: busy` | An `exclusive` lease is held. | Retry after the lease. |
| `refused: exhausted` | `maxAttempts` known failures. | Escalate. |
| `ambiguous` | The provider may have acted. | Reconcile, or `ro.resolve(key, { outcome })` after checking. Never repeat blindly. |

BullMQ's `onceProcessor` skips a job with `ended`, `superseded`, or
`redelivered_after_write`. Treat those as success-shaped skips, not as a
reason to call the provider again.

## Signals to watch

`onEvent` reports `claimed`, `committed`, `replayed`, `in_flight`, `failed`,
`refused`, `ambiguous`, `reconciled`, `late_settle` and
`unserializable_result`. Alert on `ambiguous` (the outcome is unknown) and
`late_settle` (the effect ran, but it settled after `pendingTtlMs` or the
ledger write failed and the claim stays pending; raise `pendingTtlMs` or check
the store). There is no background reconciler: an ambiguous effect stays until the key is claimed again or someone resolves it.
