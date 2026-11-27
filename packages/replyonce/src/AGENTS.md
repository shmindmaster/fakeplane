# src

The root `AGENTS.md` applies.

TypeScript library. `replyonce.ts` is the run and `once` API. `logic.ts` is
the state machine. `stores/` is memory, Postgres, and Redis. `adapters/` is
BullMQ, webhooks, and tool-call shapes. Keep the public exports in `index.ts`
stable. Tests mount this directory read-only into the Node image.
