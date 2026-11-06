# Architecture

| Path | Owns |
| --- | --- |
| `src/backends/` | Zendesk, Slack, Linear, generic collections and routes |
| `src/server.ts` | HTTP server and `/_fakeplane` control endpoints |
| `src/mcp.ts` | MCP tools over the same operations |
| `src/runner.ts` | Seed, turns, faults, assertions |
| `src/world.ts` | The mutable state the fakes share |
| `src/scenario.ts` | YAML and JSON loading |
| `src/assertions.ts` | Effect, call, state, PII, and script assertions |
| `src/cli.ts` | `run`, `demo`, `init`, `validate`, `up`, `from-trace` |
| `demo/` | The three bundled scenarios and the two agents |
| `examples/` | A starter scenario and an MCP client |
| `action.yml` | The GitHub Action that fails a job when scenarios fail |

One process hosts every backend on one port. Switching a call from HTTP to
MCP does not change the operation id, so one fault covers both.
