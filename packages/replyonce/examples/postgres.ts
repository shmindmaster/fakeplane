/**
 * Using the Postgres store. One row per scope, locked for the duration of each decision.
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npx tsx examples/postgres.ts
 */
import pg from 'pg';
import { createReplyOnce } from 'replyonce';
import { PostgresStore } from 'replyonce/postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres' });
const store = new PostgresStore({ pool });

async function main() {
  await store.migrate(); // or run postgresSchemaSql() in your own migration tool
  const ro = createReplyOnce({ store });

  const refund = () =>
    ro.once({ scope: 'order-A-1001', intent: 'refund', payload: { order: 'A-1001', cents: 2500 } }, async (ctx) => {
      console.log('calling the payment provider with Idempotency-Key', ctx.idempotencyKey);
      return { refundId: 're_123' };
    });

  console.log((await refund()).status); // executed
  console.log((await refund()).status); // replayed
  await pool.end();
}

main();
