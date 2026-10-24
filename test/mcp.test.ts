import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorld } from "../src/backends/index.js";
import { FakeServer } from "../src/server.js";

const root = join(import.meta.dirname, "..");
let server: FakeServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const text = (r: any) => r.content.map((c: any) => c.text).join("");

describe("MCP over Streamable HTTP (official SDK client)", () => {
  it("lists tools, calls them, and records the calls", async () => {
    server = new FakeServer(createWorld({ seed: { zendesk: { tickets: [{ id: 3, subject: "Login broken" }] }, slack: { channels: [{ id: "C9", name: "alerts" }] } } }));
    const urls = await server.start();
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(urls.mcp)));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("zendesk_add_comment");
    expect(names).toContain("slack_post_message");
    expect(names).not.toContain("linear_create_issue");
    expect(tools.find((t) => t.name === "zendesk_get_ticket")?.annotations?.readOnlyHint).toBe(true);

    const got = await client.callTool({ name: "zendesk_get_ticket", arguments: { ticket_id: 3 } });
    expect(JSON.parse(text(got))).toMatchObject({ id: 3, subject: "Login broken" });
    const bad = await client.callTool({ name: "zendesk_get_ticket", arguments: { ticket_id: 404 } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("404");
    await client.callTool({ name: "slack_post_message", arguments: { channel: "alerts", text: "ticket 3 escalated" } });
    await client.close();

    expect(server.world.calls.map((c) => [c.transport, c.tool])).toEqual([
      ["mcp", "zendesk_get_ticket"],
      ["mcp", "zendesk_get_ticket"],
      ["mcp", "slack_post_message"],
    ]);
    expect(server.world.effects.map((e) => e.kind)).toEqual(["slack.message.post"]);
  });

  it("rejects unknown tools with a JSON-RPC error", async () => {
    server = new FakeServer(createWorld({ seed: { zendesk: {} } }));
    const urls = await server.start();
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(urls.mcp)));
    await expect(client.callTool({ name: "nope", arguments: {} })).rejects.toThrow(/Unknown tool/);
    await client.close();
  });
});

describe("MCP over stdio (official SDK client)", () => {
  it("serves a scenario's tools and writes a record on exit", async () => {
    const record = join(tmpdir(), `fakeplane-mcp-${process.pid}.json`);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "dist", "cli.js"), "mcp", "--scenario", join(root, "demo", "scenarios", "refund-ambiguous-timeout.yaml"), "--record", record],
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["generic_get", "zendesk_update_ticket", "slack_post_message"]));
    const order = await client.callTool({ name: "generic_get", arguments: { collection: "orders", id: "ord_1001" } });
    expect(JSON.parse(text(order))).toMatchObject({ amount: 42.5 });
    await client.close();
    await new Promise((r) => setTimeout(r, 300));
    const saved = JSON.parse(readFileSync(record, "utf8"));
    expect(saved.calls[0]).toMatchObject({ transport: "mcp", tool: "generic_get" });
    rmSync(record, { force: true });
  });
});
