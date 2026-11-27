/**
 * Cross-language check: TypeScript and Python workers share one store.
 * Phase 1 (TS) and phase 3 (TS) bracket phase 2 (python/scripts/interop.py).
 *
 *   npx tsx scripts/interop.ts 1 <scope> && python python/scripts/interop.py <scope> && npx tsx scripts/interop.ts 3 <scope>
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';
import { createReplyOnce } from 'replyonce';
import type { Store } from 'replyonce';
import { PostgresStore } from 'replyonce/postgres';
import { RedisStore } from 'replyonce/redis';

const [phase, scopeArg] = process.argv.slice(2);
if (!scopeArg) throw new Error('usage: interop.ts <1|3> <scope>');
const scope: string = scopeArg;

async function check(name: string, store: Store) {
  const ro = createReplyOnce({ store });
  const refund = { scope, intent: 'refund', payload: { order: 'A-1001', cents: 2500 } };
  if (phase === '1') {
    assert.equal((await ro.once(refund, () => ({ refundId: 're_from_ts' }))).status, 'executed');
    const run = await ro.begin(scope, { runId: 'ts-run', contextAt: Date.now() - 1_000 });
    assert.equal(run.state, 'new');
  } else {
    // Python replayed TS's refund, started a newer run and replied through it.
    const reply = await ro.check({ scope, intent: 'reply', payload: { inReplyTo: 'm1' } });
    assert.equal(reply.status, 'committed');
    assert.deepEqual(reply.entry?.result, { messageId: 'from_python' });
    const resumed = await ro.begin(scope, { runId: 'ts-run' });
    assert.equal(resumed.state, 'superseded');
    assert.equal((await ro.once(refund, () => 'again')).status, 'replayed');
  }
  console.log(`interop phase ${phase} ok on ${name}`);
}

const pool = new pg.Pool({ connectionString: process.env.REPLYONCE_PG_URL });
const redis = new Redis(process.env.REPLYONCE_REDIS_URL ?? 'redis://localhost:6379');
try {
  const pgStore = new PostgresStore({ pool, table: 'replyonce_interop' });
  await pgStore.migrate();
  await check('postgres', pgStore);
  await check('redis', new RedisStore({ client: redis, prefix: 'replyonce-interop' }));
} finally {
  await pool.end();
  redis.disconnect();
}
