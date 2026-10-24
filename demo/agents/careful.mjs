#!/usr/bin/env node
// A careful refund agent: the same job as naive.mjs, with the habits that keep
// side effects to exactly one each.
//   - Skips a webhook it has already handled (checks the ticket's tags).
//   - Sends an idempotency key derived from the business action, not the attempt.
//   - After an ambiguous failure, reads back before writing again.
//   - Honours Retry-After on 429.
//   - Escalates refunds over the limit instead of issuing them, with no customer details in Slack.
//
// fakeplane passes each turn as JSON on stdin and the fake URLs as FAKEPLANE_* env vars.

const REFUND_LIMIT = 100;
const turn = JSON.parse(await readStdin());
const ZENDESK = process.env.FAKEPLANE_ZENDESK_URL;
const ORDERS_API = process.env.FAKEPLANE_GENERIC_URL;
const SLACK = process.env.FAKEPLANE_SLACK_URL;

const ticketId = turn.event.ticket_id;
const { ticket } = (await call("GET", `${ZENDESK}/api/v2/tickets/${ticketId}`)).data;
if (ticket.tags.includes("refund_issued") || ticket.tags.includes("escalated")) {
  console.log(`ticket ${ticketId} already handled; ignoring duplicate delivery ${turn.deliveryId}`);
  process.exit(0);
}
const { user } = (await call("GET", `${ZENDESK}/api/v2/users/${ticket.requester_id}`)).data;
const orderId = /ord_\d+/.exec(turn.text ?? ticket.description)?.[0];
const order = (await call("GET", `${ORDERS_API}/orders/${orderId}`)).data;

if (order.amount > REFUND_LIMIT) {
  await withRetries(() =>
    call("POST", `${SLACK}/chat.postMessage`, { channel: "escalations", text: `Ticket #${ticketId}: refund of $${order.amount} for ${orderId} needs approval (over the $${REFUND_LIMIT} limit).` }, `escalate:${ticketId}`),
  );
  await replyOnce(`Hi ${user.name}, your refund request is with a specialist for approval. We'll update you here within one business day.`, { status: "pending", additional_tags: ["escalated"] });
  console.log(`escalated ticket ${ticketId}`);
} else {
  await withRetries(() => call("POST", `${ORDERS_API}/refunds`, { order_id: orderId, amount: order.amount }, `refund:${orderId}`));
  await replyOnce(`Hi ${user.name}, we've refunded $${order.amount} for order ${orderId}. Sorry about that!`, { status: "solved", additional_tags: ["refund_issued"] });
  console.log(`refunded $${order.amount} for ${orderId}`);
}

/** Post a public reply plus field changes, never twice: on failure, check whether it landed. */
async function replyOnce(body, fields) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await call("PUT", `${ZENDESK}/api/v2/tickets/${ticketId}`, { ticket: { ...fields, comment: { public: true, body } } });
    if (res.ok) return;
    const comments = (await call("GET", `${ZENDESK}/api/v2/tickets/${ticketId}/comments`)).data?.comments ?? [];
    if (comments.some((c) => c.public && c.body === body)) {
      const current = (await call("GET", `${ZENDESK}/api/v2/tickets/${ticketId}`)).data.ticket;
      const missingTags = fields.additional_tags.filter((t) => !current.tags.includes(t));
      if (current.status !== fields.status || missingTags.length) {
        await call("PUT", `${ZENDESK}/api/v2/tickets/${ticketId}`, { ticket: { status: fields.status, additional_tags: missingTags } });
      }
      return;
    }
    await sleep(backoff(res, attempt));
  }
  throw new Error(`could not reply to ticket ${ticketId}`);
}

async function withRetries(fn) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fn();
    if (res.ok) return res;
    if (res.status < 500 && res.status !== 429) throw new Error(`request failed: HTTP ${res.status} ${JSON.stringify(res.data)}`);
    await sleep(backoff(res, attempt));
  }
  throw new Error("gave up after retries");
}

function backoff(res, attempt) {
  const retryAfter = Number(res.headers?.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 50 * attempt;
}

async function call(method, url, body, idempotencyKey) {
  const headers = { "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { ok: res.ok, status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
