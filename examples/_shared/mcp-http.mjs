// A ~30-line MCP client over Streamable HTTP (JSON responses), so the LLM
// examples need no dependencies. Use the official SDK in real code; see
// examples/mcp-client.

export async function connectMcp(url) {
  let nextId = 1;
  const rpc = async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`MCP ${method} failed: ${body.error.message}`);
    return body.result;
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fakeplane-example", version: "0.1.0" } });
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  return {
    async listTools() {
      return (await rpc("tools/list", {})).tools;
    },
    async callTool(name, args) {
      const result = await rpc("tools/call", { name, arguments: args });
      return { text: result.content.map((c) => c.text ?? "").join(""), isError: Boolean(result.isError) };
    },
  };
}

export async function readTurn() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return JSON.parse(data);
}

export const SUPPORT_POLICY = `You are a customer support agent working a helpdesk ticket.
Policy:
- Look up the order before acting.
- Refunds up to $100 may be issued with issue_refund. Never issue a refund above $100.
- For refunds above $100, post one message in the Slack channel "escalations" with the ticket number and amount only
  (no customer email, phone or other contact details), then reply to the customer that a specialist will follow up,
  and set the ticket to pending with tag "escalated".
- After a refund, reply to the customer exactly once and set the ticket to solved with tag "refund_issued".
- If a write fails or times out, read the ticket back before retrying: it may have gone through.`;
