# fakeplane

Stateful fakes of Zendesk, Slack, Linear, and HTTP/JSON for testing agents.
TypeScript package under `src/`. Scenarios live in YAML. There is no
application server and no `apps/` tree.

## Commands

```text
docker compose run --build --rm test
docker compose run --rm typecheck
```

Node 22. Dependencies stay in the image. Do not create `node_modules` or
`dist/` in the checkout.

## Rules

- Fakes keep state. A retry must see the write that committed during a timeout.
- Assertions count effects. A scenario with no assertions fails.
- `no_pii` redacts customer emails and phones in failure output.
- The scenario language is `docs/API.md`. Change it there when the parser changes.
- The root `AGENTS.md` applies everywhere.

## Done

Both compose commands pass. Docs match the change. Commit. The GitHub Action
check stays on the runner because `uses: ./` cannot run inside the image.
