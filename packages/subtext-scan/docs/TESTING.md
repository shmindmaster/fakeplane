# Testing

```text
docker compose run --build --rm test
docker compose run --rm typecheck
```

`npm test` is `node --test` over `tests/`. The suite covers the public API,
the CLI, fixtures, MCP, and the phrase rules. `typecheck` is `tsc`.

CI (`.github/workflows/ci.yml`) runs both on Ubuntu, plus `npm audit` for
production dependencies. The supplier-certificate fixture must exit 1.
`CONTRIBUTING.md`, `SECURITY.md`, `NOTICE`, `README.md`, and `docs/*.md`
must stay under the high gate. `docker compose run --rm fixtures` regenerates
`fixtures/` and CI fails if that changes the tree.

`npm run smoke:package` packs and installs the tarball inside the image.
CI runs it. Do not run it on the host.
