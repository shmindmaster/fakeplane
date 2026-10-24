#!/usr/bin/env node
// A deliberately naive refund agent. It looks fine in a happy-path demo, but it
// retries writes blindly, has no idempotency keys, handles every webhook it is
// sent, ignores the refund limit and pastes customer details into Slack.
// fakeplane's demo scenarios exist to catch exactly these bugs.

const turn = JSON.parse(await readStdin());
const ZENDESK = process.env.FAKEPLANE_ZENDESK_URL;
const ORDERS_API = process.env.FAKEPLANE_GENERIC_URL;
const SLACK = process.env.FAKEPLANE_SLACK_URL;

const ticketId = turn.event.ticket_id;
const { ticket } = (await call("GET", `${ZENDESK}/api/v2/tickets/${ticketId}`)).data;
const { user } = (await call("GET", `${ZENDESK}/api/v2/users/${ticket.requester_id}`)).data;
const orderId = /ord_\d+/.exec(turn.text ?? ticket.description)?.[0];
const order = (await call("GET", `${ORDERS_API}/orders/${orderId}`)).data;

await retryOnce(() => call("POST", `${ORDERS_API}/refunds`, { order_id: orderId, amount: order.amount }));
await retryOnce(() =>
  call("PUT", `${ZENDESK}/api/v2/tickets/${ticketId}`, {
    ticket: {
      status: "solved",
      additional_tags: ["refund_issued"],
      comment: { public: true, body: `Hi ${user.name}, we've refunded $${order.amount} for order ${orderId}. Sorry about that!` },
    },
  }),
);
if (order.amount > 100) {
  await call("POST", `${SLACK}/chat.postMessage`, {
    channel: "escalations",
    text: `FYI: issued a $${order.amount} refund to ${user.name} (${user.email}, ${user.phone}) for ${orderId}`,
  });
}
console.log(`refunded $${order.amount} for ${orderId}`);

async function retryOnce(fn) {
  const first = await fn();
  return first.ok ? first : fn();
}

async function call(method, url, body) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
