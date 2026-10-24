# Scenario reference

A scenario is a YAML or JSON file. `fakeplane run <dir>` loads every `.yaml`, `.yml` and `.json` file under the directory, skipping names that start with `_` or `.`. A YAML file may hold several scenarios separated by `---`.

```yaml
name: string                 # default: file name
description: string
tags: [string]
clock: 2026-01-01T00:00:00Z  # virtual start time; each call advances it by 1s
backends: [zendesk, slack, linear, generic]   # default: the ones in seed (all four if seed is empty)
agent: { command | url | module, timeoutMs, env, cwd }
seed: { zendesk, slack, linear, generic }
turns: [...]
faults: [...]
assert: [...]
repeat: 1                    # run the scenario N times
min_pass_rate: 1             # with repeat: fraction of runs that must pass
allow_agent_errors: false    # keep going (and still assert) when the agent exits non-zero
```

## Agent

| Field | Meaning |
|---|---|
| `command` | Shell command run once per delivery. The turn is written to stdin as JSON. Non-zero exit is an agent error. |
| `url` | The turn is POSTed as JSON. Non-2xx is an agent error. |
| `module` | A JS module whose default export is `async (turn, { env }) => output`. |
| `timeoutMs` | Per delivery. Default 120000. |
| `env` | Extra environment variables (command mode) or `ctx.env` (module mode). |
| `cwd` | Working directory for `command`, relative to the scenario file. |

Precedence: `--agent` on the command line, then the scenario's `agent`, then `fakeplane.config.yaml`.

The turn payload:

```json
{
  "fakeplane": "0.1.0",
  "scenario": "refund reply times out after it was saved",
  "turn": 1,
  "delivery": 1,
  "deliveryId": "evt_001",
  "via": "zendesk",
  "text": "I was charged twice...",
  "event": { "type": "zendesk.ticket.created", "id": "evt_001", "ticket_id": 1, "comment": { }, "ticket": { } },
  "history": [],
  "urls": { "base": "http://127.0.0.1:53211", "mcp": ".../mcp", "zendesk": ".../zendesk", "slack": ".../slack/api", "linear": ".../linear/graphql", "generic": ".../generic" }
}
```

## Seed

### zendesk

```yaml
zendesk:
  agent_user_id: 1                     # the user the agent writes as
  users: [{ id: 100, name: Sam, email: sam@example.com, phone: "+1 415 555 0100" }]
  groups: [{ id: 10, name: Billing }]  # when set, group_id updates must reference one
  tickets:
    - id: 1
      subject: Where is my order?
      status: open                     # new | open | pending | hold | solved | closed
      priority: normal                 # low | normal | high | urgent
      tags: [vip]
      requester_id: 100                # or requester: { name, email }
      comments: [{ body: "It's late", author_id: 100, public: true }]
```

State path: `zendesk.tickets.<id>` (with `comments`), `zendesk.users.<id>`.

| MCP tool | HTTP | Effect kinds |
|---|---|---|
| `zendesk_list_tickets` | `GET /api/v2/tickets` | |
| `zendesk_get_ticket` | `GET /api/v2/tickets/{id}` | |
| `zendesk_get_comments` | `GET /api/v2/tickets/{id}/comments` | |
| `zendesk_create_ticket` | `POST /api/v2/tickets` | `zendesk.ticket.create` |
| `zendesk_update_ticket` | `PUT /api/v2/tickets/{id}` (`ticket.comment`, `status`, `tags`, `additional_tags`, `remove_tags`, ...) | `zendesk.ticket.update`, `zendesk.ticket.reply`, `zendesk.ticket.note` |
| `zendesk_add_comment` | | `zendesk.ticket.reply` (public) / `zendesk.ticket.note` (internal) |
| `zendesk_add_tags` / `zendesk_remove_tags` | `PUT` / `DELETE /api/v2/tickets/{id}/tags` | `zendesk.ticket.update` |
| `zendesk_search` | `GET /api/v2/search?query=status:open tags:vip text` | |
| `zendesk_get_user` | `GET /api/v2/users/{id}` | |

Paths work with or without the `/zendesk` prefix and with or without `.json`. Closed tickets reject updates with 422, invalid statuses and priorities are rejected, and empty tag lists are errors rather than no-ops.

### slack

```yaml
slack:
  bot_user_id: UBOT
  users: [{ id: U1, name: sam, email: sam@example.com }]
  channels: [{ id: C1, name: support }]
  messages: [{ channel: C1, user: U1, text: "help", ts: "1767225600.000001" }]
```

State path: `slack.channels.<id>.messages`.

| MCP tool | HTTP (`/slack/api/...` or `/api/...`) | Effect kinds |
|---|---|---|
| `slack_post_message` | `chat.postMessage` | `slack.message.post` |
| `slack_update_message` | `chat.update` | `slack.message.update` |
| `slack_get_history` | `conversations.history` | |
| `slack_get_thread` | `conversations.replies` | |
| `slack_list_channels` | `conversations.list` | |
| `slack_add_reaction` | `reactions.add` | `slack.reaction.add` |
| `slack_get_user` | `users.info` | |

Channels resolve by id, name or `#name`. API errors return HTTP 200 with `ok: false`, as Slack does. Form-encoded and JSON bodies both work.

### linear

```yaml
linear:
  teams: [{ key: ENG, name: Engineering }]          # default: ENG
  users: [{ id: u1, name: Ana, email: ana@example.com }]
  states: [{ name: Triage, type: triage }]          # default: Backlog, Todo, In Progress, Done, Canceled
  labels: [{ name: bug }]
  issues: [{ identifier: ENG-1, title: Crash, state: Todo, priority: 2, labels: [bug], assignee: u1 }]
```

State path: `linear.issues.<IDENTIFIER>`.

| MCP tool | GraphQL | Effect kinds |
|---|---|---|
| `linear_create_issue` | `issueCreate(input)` | `linear.issue.create` |
| `linear_update_issue` | `issueUpdate(id, input)` | `linear.issue.update` |
| `linear_add_comment` | `commentCreate(input)` | `linear.comment.create` |
| `linear_get_issue` | `issue(id)` | |
| `linear_list_issues` | `issues(filter, first)`, `searchIssues(term)` | |
| `linear_list_teams` | `teams`, `viewer` | |

### generic

```yaml
generic:
  collections:                 # stateful JSON records
    orders: [{ id: o1, amount: 30 }]
  collection_tools: true       # expose generic_list/get/create/update/delete over MCP (default: true if collections exist)
  routes:                      # custom HTTP endpoints, served under /generic and at their literal path
    - method: POST
      path: /v1/refunds/:id
      status: 201
      response: { id: "{{id}}", amount: "{{body.amount}}", order: "{{params.id}}" }
      effect: refund           # records generic.refund (default for non-GET: the route name)
      reject: [{ when: { amount: { gt: 500 } }, status: 403, message: over limit }]
  tools:                       # custom MCP tools
    - name: issue_refund
      description: Refund an order
      inputSchema: { type: object, properties: { order_id: { type: string }, amount: { type: number } } }
      collection: refunds      # back it with a collection...
      action: create           # get | list | create | update | delete
      id_field: order_id       # for get/update/delete
    - name: weather
      responses: [{ temp: 1 }, { temp: 2 }]   # ...or canned responses, in order (last repeats)
      write: false
```

Collection effects: `generic.<collection>.create|update|delete`. Custom tool effects: `generic.<effect or tool name>`. State path: `generic.collections.<name>.<id>`.

## Turns

A string is shorthand for `{ text }`. Otherwise:

| Field | Meaning |
|---|---|
| `via` | `zendesk`, `slack`, `linear` or `none`. Inferred from the other fields, or from the only seeded helpdesk/chat backend. |
| `text` | What the user says. |
| `ticket`, `from`, `subject`, `tags` | Zendesk: add a customer comment to `ticket`, creating it (with requester `from`) if missing. Pending/solved tickets reopen. |
| `channel`, `user`, `thread_ts`, `mention` | Slack: post the user's message; the agent gets an Events API `event_callback`. |
| `issue`, `team`, `title` | Linear: comment on `issue`, or create an issue in `team`; the agent gets a webhook-shaped payload. |
| `event` | Send this payload verbatim instead. |
| `deliver` | Deliver the same event N times with the same `deliveryId`. |
| `concurrent` | Deliver the copies at the same time. |
| `delayMs` | Wait before the turn. |

## Faults

| Field | Meaning |
|---|---|
| `op` | Operation id (`zendesk.ticket.update`, `generic.create`, `generic.tool.issue_refund`) or MCP tool name, globs allowed. |
| `backend` | Restrict to one backend. |
| `where` | Match the operation input, e.g. `{ collection: refunds }`. |
| `kind` | `timeout`, `rate_limit`, `error`, `partial`, `latency`, `duplicate_delivery`. |
| `after` | Let this many matching calls through first. |
| `times` | How many times to fire (default 1, or `always`). |
| `committed` | Whether the write still happens. Default true for `partial` and `latency`, false otherwise. |
| `status`, `message`, `retryAfter`, `delayMs`, `drop` | Shape the failure. `drop` closes the HTTP connection without a response. |
| `turn`, `copies`, `concurrent` | For `duplicate_delivery`. |

Operation ids are listed in the tables above. HTTP calls and MCP calls hit the same operations, so one fault covers both.

## Assertions

Every assertion has an optional `name` and exactly one of:

| Key | Other fields |
|---|---|
| `effects: <kind glob>` | `where`, `count` or `min`/`max` (default `min: 1`), `turn` |
| `calls: <op or tool glob>` | `where` (on the input), `ok: true|false`, `count`/`min`/`max`, `turn` |
| `state: <dotted path>` | `match`, or `exists: false` |
| `no_pii: true` or `{ effects, allow, values, seeded, types }` | `seeded` (default true) adds the seed's customer emails and phones to `values`. Internal Zendesk notes are skipped unless `effects` is set. |
| `no_duplicate_effects: true` or `{ effects, ignore }` | `ignore` defaults to `id`, `identifier`, `ts`, `comment_id`, `created_at`, `updated_at` |
| `agent_output: <matcher>` | A string means `contains`. |
| `script: ./file.mjs` | Default export receives `{ calls, effects, state, turns }` and returns `true`, `false`, a failure message, or `{ ok, message }`. |

A scenario with no assertions fails, so it can't pass by accident.

## Config file

`fakeplane.config.yaml` (or `.yml`/`.json`) in the working directory, or `--config <file>`:

```yaml
scenarios: scenarios           # default path for `fakeplane run`
agent: { command: node agent.js }
repeat: 1
assert:                        # appended to every scenario
  - no_duplicate_effects: true
  - no_pii: true
```

## Control endpoints (`fakeplane up`)

| Endpoint | |
|---|---|
| `GET /_fakeplane/health` | Status and counts |
| `GET /_fakeplane/state` / `calls` / `effects` / `report` | Recorded data |
| `POST /_fakeplane/reset` | Rebuild state from the seed |
| `POST /_fakeplane/faults` | Replace faults: `{ "faults": [...] }` |
| `POST /_fakeplane/turn` | Apply a user turn and get the event back |
| `POST /_fakeplane/assert` | Evaluate `{ "assert": [...] }` against the current state |
