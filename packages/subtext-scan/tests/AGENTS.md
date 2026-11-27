# tests

The root `AGENTS.md` applies.

```text
docker compose run --build --rm test
```

`node --test` runs the suite. It must pass without a network connection.
The malicious PDF fixture is expected to exit 1 from the CLI.
