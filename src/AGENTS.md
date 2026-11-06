# src

The root `AGENTS.md` applies.

`backends/` is Zendesk, Slack, Linear, generic HTTP, and GraphQL.
`runner.ts` seeds, delivers turns, and records effects. `assertions.ts` and
`matchers.ts` decide pass or fail. `mcp.ts` exposes the same operations as
HTTP. `pii.ts` finds contact details in effect text. Keep HTTP and MCP on
one operation id so a fault covers both.
