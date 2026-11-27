# Testing

```text
docker compose run --build --rm test
docker compose run --rm typecheck
docker compose run --build --rm python
```

Node tests live in `test/` and use Vitest. Every store suite runs against
memory, plus Postgres when `REPLYONCE_PG_URL` is set and Redis when
`REPLYONCE_REDIS_URL` is set, which compose does.

| File | Covers |
| --- | --- |
| `once.test.ts` | The ledger: replay, `NotApplied`, ambiguous, reconcile, resolve |
| `runs.test.ts` | Runs: supersede, exclusive leases, redelivery, the conversation fence |
| `race.test.ts` | Parallel workers, redelivery storms, concurrent runs on one scope |
| `demo.test.ts` | The chaos demo on every store: no duplicate, none unanswered. Same counts per seed is checked on the simulated-time memory demo only |
| `adapters.test.ts` | Tools, webhooks, BullMQ |
| `key.test.ts`, `migrate.test.ts` | Key hashing, concurrent `migrate()` |
| `cli.test.ts` | The built CLI. Skipped until `dist/` exists. |

Python tests live in `python/tests/` and use pytest. They cover the same
once, race, run, adapter, key, migration, and demo behaviour.

CI (`.github/workflows/ci.yml`) runs those three compose commands on Ubuntu
on every push to `main` and every pull request. The image is the runtime
under test. A change to store behaviour needs both suites.

## Not in CI

These run in the release workflows or by hand, not on pull requests:

| Check | How to run it |
| --- | --- |
| Build and `cli.test.ts` | `docker compose run --rm test sh -c "npm run build && npm test"` |
| CJS and ESM smoke | `docker compose run --rm test sh -c "npm run build && npm run smoke"` (also in `release.yml`) |
| Examples | `docker compose run --rm test sh -c "npm run build && npx tsx examples/quickstart.ts"` (examples import the built `replyonce`), and the other files in `examples/` |
| Node and Python on one store | `scripts/interop.ts` phases 1 and 3 around `python/scripts/interop.py` |
| Node 18 and 20 | The package declares Node 18+. No job checks the built output there now. |
