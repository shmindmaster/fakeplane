# Contributing

Thanks for helping. replyonce is small on purpose. The bar for a change is whether it keeps
a duplicate effect from reaching a customer, or makes an honest limit clearer.

## Setup

Git and Docker are enough. Do not install Node or Python on the host, and do not create
`node_modules`, `dist` or `python/.venv` in the checkout.

```sh
git clone https://github.com/shmindmaster/replyonce
cd replyonce
docker compose run --build --rm test      # Vitest against memory, Postgres and Redis
docker compose run --rm typecheck         # tsc --noEmit
docker compose run --build --rm python    # pytest against memory, Postgres and Redis
docker compose down                       # stop Postgres and Redis
```

Compose starts Postgres 16 and Redis 7 and sets `REPLYONCE_PG_URL` and `REPLYONCE_REDIS_URL`
for the suites. The images use Node 22 and Python 3.12. The published npm package supports
Node 18+ and the Python package 3.10+. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and
[docs/TESTING.md](docs/TESTING.md) have the details, including the checks CI does not run.

`python/src/replyonce/_logic.py` is a line-for-line port of `src/logic.ts`. A change to one
needs the same change, and a test, in the other. `scripts/interop.ts` and
`python/scripts/interop.py` check that the two share a store correctly.

## Ground rules

- **The state machine stays pure.** All decisions live in `src/logic.ts` as functions from
  state to state. Stores only make `transact` atomic. Do not put decision logic in a store.
- **Every bug fix comes with a test that fails without it.** For a race, add it to
  `test/race.test.ts` or as a fault in the chaos demo (`src/demo.ts`). It must pass against
  all three stores.
- **No runtime dependencies.** Stores take structural clients (`pg.Pool`-like, `eval`-capable).
- **The public API is small and stable.** New options need a clear failure they prevent.
  Breaking changes wait for a major version.
- **Claims match tests.** If a change affects a guarantee or a limit, update the README in
  the same pull request.
- **Generic examples only.** No real customer, company or personal data in code, tests or docs.

## Pull requests

1. Open an issue first for anything larger than a fix.
2. Keep commits focused. CI must be green: the Node suite and typecheck, and the Python suite,
   each against all three stores, with the chaos demo in both suites.
3. Add a line to `CHANGELOG.md` under "Unreleased".

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
