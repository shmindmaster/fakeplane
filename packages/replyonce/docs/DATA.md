# Data

No database ships inside the library. Callers choose a store and pass it a
client. The library itself reads no environment variables.

| Store | Where state lives |
| --- | --- |
| `MemoryStore` | Process memory. Tests, the demo, and single-instance services. |
| `PostgresStore` | One table, default `replyonce_scopes` (`table` option). `migrate()` or `postgresSchemaSql()` creates it. |
| `RedisStore` | One key per scope, `<prefix>:{<scope>}` (default prefix `replyonce`), expiring after `keyTtlMs` (default 30 days). |

The Postgres table:

| Column | Type | Holds |
| --- | --- | --- |
| `scope` | `text` primary key | The scope, usually a conversation id |
| `state` | `jsonb` | The scope's state document |
| `version` | `bigint` | Incremented on every write |
| `updated_at` | `timestamptz` | Last write |

The state document (`ScopeState`, `v: 1`) holds a logical sequence counter,
a fencing token counter, `runs` (run id, token, mode, lease, `contextAt`,
what the run has seen, end reason) and `effects` (the ledger: key, intent,
status, attempt, run and token, `summary`, stored `result` or `error`, claim
and settle times). Node and Python write the same document. Do not change a
field without a migration test in both trees.

Settled effects and ended runs older than `retentionMs` (default 7 days) are
dropped the next time their scope is written, not on a timer, so an idle scope
keeps them. Ambiguous effects are never pruned by `retentionMs`. A Redis key
still expires `keyTtlMs` after its last write, and that removes the whole
scope, unresolved effects included. `summary`, results and
error text can hold personal data; see [SECURITY.md](SECURITY.md).

The demo does not persist. Postgres and Redis in `compose.yaml` are empty
local databases for the suites, and they are discarded with the compose
project. There is no customer dataset in this repository.
