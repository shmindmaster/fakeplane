# Product

Stops an agent from replying, refunding, or ticketing twice when retries,
redelivered webhooks, queue jobs, or overlapping runs hit the same customer.

- Each effect runs at most once per business identity.
- A stale run cannot write after a newer run takes the conversation.
- A run is told when the conversation changed under it, and the write is
  refused with what happened.
- An unknown outcome is not retried blindly.

The demo simulates 100 support conversations under injected faults
(worker crash, duplicate delivery, customer burst, timeout before send,
timeout after send). With replyonce, no customer message is answered twice.
The demo runs on simulated time, so a seed always gives the same counts. The
default seed is 7, and `--seed N` picks another run. The Node suite runs the
demo against memory, Postgres, and Redis, the Python suite runs it in memory,
and both fail on a single duplicate.

Zero runtime dependencies on Node. Optional stores are Postgres and Redis.
The Python package mirrors the API and has optional `postgres` and `redis`
extras.
