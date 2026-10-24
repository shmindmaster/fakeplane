#!/usr/bin/env node
// An MCP-native agent using the official MCP TypeScript SDK. The decision logic
// is scripted (no LLM) so it runs anywhere; swap in your model loop. What
// matters is the wiring: connect to FAKEPLANE_MCP_URL like any MCP server.
//
//   npm install @modelcontextprotocol/sdk
//   npx fakeplane run examples/scenarios --agent "node examples/mcp-client/agent.mjs"

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const turn = JSON.parse(raw);

const client = new Client({ name: "example-mcp-agent", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.FAKEPLANE_MCP_URL)));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text ?? "").join("");
  return { ok: !r.isError, text, data: r.isError ? undefined : JSON.parse(text) };
};

const ticketId = turn.event.ticket_id;
const ticket = (await call("zendesk_get_ticket", { ticket_id: ticketId })).data;
if (ticket.tags.includes("refund_issued") || ticket.tags.includes("escalated")) {
  console.log("already handled");
} else {
  const orderId = /ord_\d+/.exec(turn.text ?? ticket.description)?.[0];
  const order = (await call("lookup_order", { order_id: orderId })).data;
  let reply;
  let fields;
  if (order.amount > 100) {
    await call("slack_post_message", { channel: "escalations", text: `Ticket #${ticketId}: refund of $${order.amount} needs approval.`, idempotency_key: `escalate:${ticketId}` });
    reply = "Your refund request is with a specialist for approval. We'll follow up here.";
    fields = { status: "pending", add_tags: ["escalated"] };
  } else {
    await call("issue_refund", { order_id: orderId, amount: order.amount, idempotency_key: `refund:${orderId}` });
    reply = `We've refunded $${order.amount} for order ${orderId}.`;
    fields = { status: "solved", add_tags: ["refund_issued"] };
  }
  const res = await call("zendesk_update_ticket", { ticket_id: ticketId, ...fields, comment: { body: reply, public: true } });
  if (!res.ok) {
    // Ambiguous failure: check whether the reply landed before sending it again.
    const comments = (await call("zendesk_get_comments", { ticket_id: ticketId })).data;
    const landed = comments.some((c) => c.public && c.body === reply);
    await call("zendesk_update_ticket", landed ? { ticket_id: ticketId, ...fields } : { ticket_id: ticketId, ...fields, comment: { body: reply, public: true } });
  }
  console.log(reply);
}
await client.close();
