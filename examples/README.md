# Examples

Three agents, one set of scenarios (`examples/scenarios/`). Each agent gets the
turn as JSON on stdin and reaches the fakes through `FAKEPLANE_MCP_URL`.

| Example | Needs | Run |
|---|---|---|
| [`mcp-client/`](mcp-client/agent.mjs): official MCP TypeScript SDK, scripted logic | `npm i @modelcontextprotocol/sdk` | `npx fakeplane run examples/scenarios --agent "node examples/mcp-client/agent.mjs"` |
| [`openai/`](openai/agent.mjs): Chat Completions tool-calling loop | `OPENAI_API_KEY` (optional `OPENAI_MODEL`, `OPENAI_BASE_URL`) | `npx fakeplane run examples/scenarios --agent "node examples/openai/agent.mjs" --repeat 3` |
| [`anthropic/`](anthropic/agent.mjs): Messages API tool-use loop | `ANTHROPIC_API_KEY` (optional `ANTHROPIC_MODEL`) | `npx fakeplane run examples/scenarios --agent "node examples/anthropic/agent.mjs" --repeat 3` |

The LLM examples list tools from fakeplane's MCP server and hand them to the
model as functions, so the model sees the same tool surface it would in
production. Use `--repeat` with real models: they are not deterministic, and
one green run proves little.

The scenarios inject an ambiguous timeout on the ticket reply (the write
lands, the agent sees a 504) and a refund above the policy limit. Expect real
models to fail some runs; that is the point.

## Your own agent

Any process works. fakeplane runs your command once per turn (and once per
duplicate delivery), writes the turn to stdin, and sets:

| Variable | Points at |
|---|---|
| `FAKEPLANE_MCP_URL` | MCP server (Streamable HTTP) with every fake's tools |
| `FAKEPLANE_ZENDESK_URL` | Zendesk-style REST base (`/api/v2/...`) |
| `FAKEPLANE_SLACK_URL` | Slack Web API base (`/chat.postMessage`, ...) |
| `FAKEPLANE_LINEAR_URL` | Linear-style GraphQL endpoint |
| `FAKEPLANE_GENERIC_URL` | Generic JSON collections and custom routes |
| `FAKEPLANE_URL` | Server root (custom routes are also served here at their literal path) |

If your agent reads base URLs from config, set them to these values in the
scenario's `agent.env`, or in `fakeplane.config.yaml`.
