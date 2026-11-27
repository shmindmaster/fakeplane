# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub private vulnerability reporting](https://github.com/shmindmaster/replyonce/security/advisories/new).
Do not open a public issue.

Include the version, the store (memory, Postgres or Redis), and a reproduction if you can.
You should get an acknowledgement within 5 business days. A fix or mitigation plan should
follow within 30 days for confirmed issues.

In scope:

- A way to make replyonce execute a committed effect again, start two concurrent attempts
  for one key, or let a superseded or cancelled run claim a write, beyond the limits the
  README states.
- Injection through scope names, keys or table names.
- Anything that leaks one scope's ledger into another.

## Supported versions

Security fixes go to the latest minor release.

## Handling ledger data

The ledger stores what you give it: `summary` text, effect results and error messages. These
can contain personal data, such as reply text or customer identifiers. To limit that:

- Keep summaries short, and leave secrets and payment details out of them.
- Return only what you need from an effect, since the result is stored for replay.
- Restrict access to the Postgres table or Redis keys as you would for the data itself, and
  set `retentionMs` (and `keyTtlMs` for Redis) to match your retention policy.
- `pg` and Redis connections should use TLS and credentials outside source control.
