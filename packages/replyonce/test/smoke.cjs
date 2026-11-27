// CommonJS consumers get the same API.
const assert = require('node:assert/strict');
const { MemoryStore, createReplyOnce } = require('replyonce');
const { guardTool } = require('replyonce/adapters');
const { PostgresStore } = require('replyonce/postgres');
const { RedisStore } = require('replyonce/redis');

(async () => {
  const ro = createReplyOnce({ store: new MemoryStore() });
  let n = 0;
  assert.equal((await ro.once('cjs-smoke', () => ++n)).status, 'executed');
  assert.equal((await ro.once('cjs-smoke', () => ++n)).status, 'replayed');
  assert.equal(n, 1);
  assert.equal(typeof guardTool, 'function');
  assert.equal(typeof PostgresStore, 'function');
  assert.equal(typeof RedisStore, 'function');
  console.log(`cjs smoke ok on node ${process.version}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
