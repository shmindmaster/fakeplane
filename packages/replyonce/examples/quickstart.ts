import { createReplyOnce, MemoryStore } from 'replyonce';

const ro = createReplyOnce({ store: new MemoryStore() }); // PostgresStore / RedisStore in production

let refundsIssued = 0;
const refund = () =>
  ro.once({ scope: 'order-A-1001', intent: 'refund', payload: { order: 'A-1001', cents: 2500 } }, async (ctx) => {
    // Your provider call goes here; pass ctx.idempotencyKey if it accepts one.
    refundsIssued++;
    return { refundId: 're_1' };
  });

// Three workers race, then a late retry arrives.
const raced = await Promise.all([refund(), refund(), refund()]);
const late = await refund();

console.log(raced.map((r) => r.status)); // [ 'executed', 'in_flight', 'in_flight' ]
console.log(late.status, late.ok && late.value); // replayed { refundId: 're_1' }
console.log(refundsIssued); // 1
