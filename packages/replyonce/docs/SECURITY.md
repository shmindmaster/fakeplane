# Security

The ledger stores what callers give it: `summary` text, effect results, and
error messages. Payloads are hashed into the key and are not stored. Keep
summaries and results to what replay needs, and leave secrets and payment
details out. The root [SECURITY.md](../SECURITY.md) has the reporting policy
and the ledger data guidance.

- Store URLs and passwords stay in the environment. The compose file uses
  the local development password `postgres` for the throwaway database only.
- Do not commit `.env` files.
- A stale fencing token must fail closed. Do not add a path that writes
  after `superseded`.
- An ambiguous timeout must not be retried as if it were a clean failure.
- The published packages have no runtime network calls of their own. Postgres
  and Redis clients connect only where the caller points them.
