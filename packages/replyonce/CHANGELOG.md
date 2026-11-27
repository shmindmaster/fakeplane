# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

- Removed a redundant bool check from Python key normalization; booleans remain JSON literals.
- Python canonical keys now match ECMAScript `Number::toString` for every finite JSON number,
  including exponent-format and large values. Previously Python emitted `1e-07` where Node emits
  `1e-7`, and integral doubles above 2**53 used the exact binary integer instead of the shortest
  round-trip decimal, so the two packages derived different ledger keys from the same payload.
  This changes the key for payloads containing such numbers: a Python-only ledger created before
  this fix must be migrated deliberately; do not rekey silently in place.
- Docs: `docs/` and `CONTRIBUTING.md` match the current Docker CI, export map, refusal reasons,
  store layout and release workflows, with runtime and release diagrams.
- Internal helpers in `src/key.ts`, `src/logic.ts` and `src/demo.ts` are no longer exported from
  their modules. None was part of the package's public entry points; no API change.

## 0.1.3 - 2026-10-25

Python package only.

- `replyonce demo --seed N` is deterministic, as in the npm package: the in-memory demo runs on
  a simulated-time event loop, so a seed always prints the same counts (and finishes in about a
  second). `run_demo(store=...)` still runs on the wall clock; `real_time` chooses explicitly.

## 0.1.1 (npm) - 2026-10-25

npm package only; the Python package's own 0.1.1 is listed below.

- `replyonce demo --seed N` is deterministic: the in-memory demo runs on simulated time, so a
  seed always prints the same counts (and finishes faster). `runDemo` with a `store` still runs
  on the wall clock; `realTime` chooses explicitly.
- The demo CLI colours its report (duplicates, unanswered, verdict) in a terminal and honours
  `FORCE_COLOR` when piped or recorded; `FORCE_COLOR=0` or `NO_COLOR` turn colour off.
- `ReplyOnceOptions.sleep`: an optional wait function, used with `clock` to run on simulated time.

## 0.1.2 - 2026-10-24

Python package only. The npm package's first published version, 0.1.0, already includes this
fix.

- Fixed (TypeScript and Python): a customer message could be left unanswered when two runs
  had the same `contextAt` millisecond, for example two messages of a burst. The tie was
  broken by which run began first, so the run for the later message could be superseded by
  the run for the earlier one, which never saw it. Runs whose contexts share a timestamp are
  now peers that may both write, and the conversation fence keeps them from answering the
  same message twice. Runs begun without `contextAt` are still ordered by when they began.
  Found by the Postgres chaos demo in CI.

## 0.1.1 - 2026-10-24

Python package only. The npm package's first published version, 0.1.0, already includes this
fix.

- Fixed: `PostgresStore.migrate()` (TypeScript and Python) is safe when several workers call
  it at once. Concurrent `CREATE TABLE IF NOT EXISTS` could fail with a unique-violation on
  `pg_type`; migrations of the same table are now serialized with an advisory lock. Found by
  the new Windows CI job.
- CI runs every job on Ubuntu, macOS and Windows against real Postgres and Redis.

## 0.1.0 - 2026-10-23

First release.

- `once(key, effect)` with an effect ledger: `pending`, `committed`, `failed`, `ambiguous`.
- Keys from scope, intent and a canonical hash of the business identity; a stable provider
  idempotency key per effect.
- Runs with fencing tokens. `supersede` mode lets the newest context own the scope;
  `exclusive` mode allows one lease holder at a time, with takeover after expiry.
- Redelivery handling: the same `runId` resumes the run, fences earlier deliveries, and
  replays completed effects.
- Conversation fence: `conversation_changed` refusals with conflict details and an ack, with
  ordering by a logical clock, plus `contextAt` for snapshot-time context.
- Ambiguous outcomes are not retried; supports an optional reconciler and `resolve()`.
- Stores: memory, Postgres (row lock per scope) and Redis (Lua compare-and-set).
- Adapters: guarded tools with OpenAI and Anthropic tool shapes, a read-only
  `check_already_done` tool, a webhook handler with HTTP status mapping, and a BullMQ processor wrapper.
- `npx replyonce demo` chaos simulation.
- Python port (`pip install replyonce`): asyncio API with the same state machine, key
  hashing and store layout, so Node and Python workers can share a store.
