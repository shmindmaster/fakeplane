# Changelog

## 0.1.0 (2026-10-23)

First release.

- Stateful fakes: Zendesk-style tickets, Slack-style messages, Linear-style issues (GraphQL), and generic JSON collections, routes and tools.
- Served over HTTP (REST/GraphQL shapes of the real APIs) and MCP (Streamable HTTP and stdio), recording every call and side effect.
- Scenario files (YAML/JSON): seed state, scripted user turns, duplicate deliveries, faults (timeouts that commit, 429s, errors, partial failures, latency, dropped connections), idempotency keys.
- Assertions on effects, calls, state, PII, duplicates, agent output and custom scripts.
- `fakeplane run` with console, JUnit, JSON and Markdown reports; `--repeat` and pass rates.
- `fakeplane from-trace`: OTLP JSON, OpenAI and Anthropic transcripts to regression scenarios, with PII redaction.
- `fakeplane up`, `report`, `mcp`, `validate`, `demo`, `init`.
- GitHub Action that fails the job when a scenario fails.
- Examples: OpenAI tool calling, Anthropic tool use, MCP SDK client.
