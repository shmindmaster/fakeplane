# Integrations

The fakes speak the subset of each vendor's API that an agent uses to
read and to write. The full operation tables are in `API.md`.

| Surface | Notes |
| --- | --- |
| Zendesk | Tickets, comments, tags, search. Closed tickets reject updates with 422. |
| Slack | `chat.postMessage`, history, reactions. Errors are HTTP 200 with `ok: false`. |
| Linear | GraphQL issue create, update, comment, and list. |
| Generic | JSON collections plus declared routes and MCP tools. |
| MCP | One server for every backend. Tool names match the HTTP operations. |
| GitHub Action | `action.yml` runs scenarios and fails the job when assertions fail. |
| Traces | `from-trace` turns an OpenAI, Anthropic, or OTLP transcript into a scenario. |

There is no call to the real Zendesk, Slack, or Linear APIs.
