# Development

```text
docker compose run --build --rm test
docker compose run --rm typecheck
docker compose run --rm test node bin/subtext-scan.mjs scan fixtures/pdf/supplier-certificate-hidden-note.pdf
```

The third command is expected to exit 1. That is a finding, not a crash.

Rebuild when `package.json` or `package-lock.json` changes. `src/`, `bin/`,
`tests/`, and `scripts/` are mounted read-only on `test`. The `fixtures`
service mounts `fixtures/` writable, because the generator replaces the
files in place.

```text
docker compose run --rm fixtures
```

Do not install Node on the host for this repository.
