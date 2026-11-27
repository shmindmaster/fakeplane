// Runs against the built package on every supported Node version (including 18).
import assert from 'node:assert/strict';
import { MemoryStore, createReplyOnce } from 'replyonce';
import { guardTool, onceProcessor, webhookOnce } from 'replyonce/adapters';
import { PostgresStore } from 'replyonce/postgres';
import { RedisStore } from 'replyonce/redis';

const ro = createReplyOnce({ store: new MemoryStore() });
let n = 0;
const key = { scope: 'smoke', intent: 'reply', payload: { to: 'm1' } };
assert.equal((await ro.once(key, () => ++n)).status, 'executed');
assert.equal((await ro.once(key, () => ++n)).status, 'replayed');
assert.equal(n, 1);

const run = await ro.begin('smoke-conv');
assert.equal((await run.once('x', 1, () => 1)).status, 'executed');
assert.equal(typeof guardTool, 'function');
assert.equal(typeof onceProcessor, 'function');
assert.equal((await webhookOnce(ro, { scope: 's', eventId: 'e' }, () => 1)).status, 200);
assert.equal(typeof PostgresStore, 'function');
assert.equal(typeof RedisStore, 'function');
console.log(`esm smoke ok on node ${process.version}`);
