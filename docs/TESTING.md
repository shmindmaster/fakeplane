# Testing

```text
docker compose run --build --rm test
docker compose run --rm typecheck
```

Vitest covers the runner, HTTP, MCP, matchers, traces, and the CLI.
`npm test` builds first, so a type error fails the suite.

CI runs that image on Ubuntu. A separate job runs `action.yml` on the
GitHub runner, because a local action executes on the runner: the careful
agent must pass and the naive agent must fail, and the JUnit files must
agree.

A scenario with no assertions fails. Add an assertion in the same change
as a new scenario.
