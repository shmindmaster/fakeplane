#!/usr/bin/env node
// Anthropic Messages API tool-use loop tested with fakeplane.
// Tools come from fakeplane's MCP endpoint and are passed to Claude as tools.
//
//   ANTHROPIC_API_KEY=... npx fakeplane run examples/scenarios --agent "node examples/anthropic/agent.mjs"
//
// Env: ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL (default claude-sonnet-4-5).

import { SUPPORT_POLICY, connectMcp, readTurn } from "../_shared/mcp-http.mjs";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY to run this example.");
  process.exit(1);
}
const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";

const turn = await readTurn();
const mcp = await connectMcp(process.env.FAKEPLANE_MCP_URL);
const tools = (await mcp.listTools()).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

const messages = [{ role: "user", content: `New helpdesk event:\n${JSON.stringify(turn.event, null, 2)}` }];

for (let step = 0; step < 15; step++) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 1024, system: SUPPORT_POLICY, messages, tools }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${JSON.stringify(data.error ?? data)}`);
  messages.push({ role: "assistant", content: data.content });
  const uses = data.content.filter((b) => b.type === "tool_use");
  if (data.stop_reason !== "tool_use" || uses.length === 0) {
    console.log(data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
    break;
  }
  const results = [];
  for (const use of uses) {
    const result = await mcp.callTool(use.name, use.input ?? {});
    results.push({ type: "tool_result", tool_use_id: use.id, content: result.text, is_error: result.isError });
  }
  messages.push({ role: "user", content: results });
}
