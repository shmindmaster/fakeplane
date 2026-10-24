#!/usr/bin/env node
// OpenAI tool-calling loop tested with fakeplane.
// Tools come from fakeplane's MCP endpoint and are passed to the model as
// functions, so the model sees the same tools it would in production.
//
//   OPENAI_API_KEY=... npx fakeplane run examples/scenarios --agent "node examples/openai/agent.mjs"
//
// Env: OPENAI_API_KEY (required), OPENAI_MODEL (default gpt-4.1-mini),
//      OPENAI_BASE_URL (default https://api.openai.com/v1; any compatible server works).

import { SUPPORT_POLICY, connectMcp, readTurn } from "../_shared/mcp-http.mjs";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Set OPENAI_API_KEY to run this example.");
  process.exit(1);
}
const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");

const turn = await readTurn();
const mcp = await connectMcp(process.env.FAKEPLANE_MCP_URL);
const tools = (await mcp.listTools()).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

const messages = [
  { role: "system", content: SUPPORT_POLICY },
  { role: "user", content: `New helpdesk event:\n${JSON.stringify(turn.event, null, 2)}` },
];

for (let step = 0; step < 15; step++) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${JSON.stringify(data.error ?? data)}`);
  const message = data.choices[0].message;
  messages.push(message);
  if (!message.tool_calls?.length) {
    console.log(message.content ?? "");
    break;
  }
  for (const call of message.tool_calls) {
    const args = JSON.parse(call.function.arguments || "{}");
    const result = await mcp.callTool(call.function.name, args);
    messages.push({ role: "tool", tool_call_id: call.id, content: result.text });
  }
}
