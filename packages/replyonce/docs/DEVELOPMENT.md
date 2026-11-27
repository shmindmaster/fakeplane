# Development

Git, Docker, and an editor are enough.

```text
docker compose run --build --rm test
docker compose run --rm typecheck
docker compose run --build --rm python
```

`test` runs Vitest. `typecheck` is `tsc --noEmit`. `python` is
`uv run pytest -q` in the Python image. Rebuild when `package.json`,
`package-lock.json`, `python/pyproject.toml`, or `python/uv.lock` changes.
Source and tests are mounted read-only, so an ordinary edit does not reinstall
dependencies. `docker compose down` stops Postgres and Redis afterwards.

Postgres 16 and Redis 7 start with the test services. The URLs are set in
`compose.yaml`. They are local to the compose project.

Do not create `node_modules`, `dist`, or `python/.venv` in the checkout.
`npm run build` (tsup) stays inside the image when a release needs `dist/`.

## Ground rules

- All decisions live in `src/logic.ts` as functions from state to state.
  Stores only make `transact` atomic.
- `python/src/replyonce/_logic.py` is a line-for-line port of `src/logic.ts`.
  A change to one needs the same change, and a test, in the other.
- No runtime dependencies. Stores take structural clients.
- A change to a guarantee or a limit updates the README in the same pull
  request, and adds a line under "Unreleased" in `CHANGELOG.md`.

[CONTRIBUTING.md](../CONTRIBUTING.md) has the full list.
