# Contributing

Thanks for helping. Bug reports with a failing scenario file are the most useful thing you can send.

## Setup

```bash
git clone https://github.com/shmindmaster/fakeplane
cd fakeplane
npm install        # also builds dist/
npm test           # build + vitest (needs Node 22+; the runtime itself supports Node 18+)
node dist/cli.js demo
```

## Layout

| Path | What |
|---|---|
| `src/world.ts` | Call/effect recorder, fault injection, idempotency, virtual clock |
| `src/backends/` | One file per fake. Each exports operations (shared by HTTP and MCP) and HTTP routes |
| `src/server.ts`, `src/mcp.ts` | HTTP server and MCP (Streamable HTTP + stdio) |
| `src/scenario.ts`, `src/assertions.ts`, `src/runner.ts` | Scenario format, assertions, agent runs |
| `src/trace.ts` | `from-trace` |
| `demo/`, `examples/` | Bundled demo and agent examples |

## Adding an operation or backend

1. Add an `Operation` with a stable `id` (`backend.noun.verb`), a `tool` spec if it should be an MCP tool, and `write: true` if it changes state.
2. Call `ctx.effect(kind, data, target)` for every side effect the real system would perform. Effects are what users assert on, so keep `data` to the fields that matter (no generated ids unless needed).
3. Fail closed: throw `ApiError` for missing or invalid input, with the status the real API uses.
4. Map HTTP routes to the operation with the real API's request and response shapes.
5. Add tests in `test/` and a row to `docs/scenarios.md`.

## Ground rules

- Fixtures must be synthetic: example domains, 555-01xx phone numbers, invented names. No real tickets, transcripts or customer data.
- Keep runtime dependencies minimal (currently `yaml` and `zod`).
- By contributing you agree your work is licensed under Apache-2.0.
