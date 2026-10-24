import { createInterface } from "node:readline";
import type { World } from "./world.js";
import { VERSION } from "./version.js";

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string; data?: unknown } };

/** Minimal MCP server exposing every fake operation that has a tool spec. Tools only; no resources or prompts. */
export class McpHandler {
  constructor(private readonly getWorld: () => World) {}

  listTools() {
    return this.getWorld()
      .tools()
      .sort((a, b) => a.tool!.name.localeCompare(b.tool!.name))
      .map((op) => ({
        name: op.tool!.name,
        description: op.tool!.description,
        inputSchema: op.tool!.inputSchema,
        annotations: { readOnlyHint: !op.write, idempotentHint: false, openWorldHint: false },
      }));
  }

  async callTool(name: string, args: Record<string, unknown> = {}) {
    const world = this.getWorld();
    const op = world.operation(name);
    if (!op || !op.tool) return undefined;
    const key = typeof args.idempotency_key === "string" ? args.idempotency_key : undefined;
    const res = await world.dispatch(op.id, args, { transport: "mcp", idempotencyKey: key, tool: name });
    if (res.ok) {
      return { content: [{ type: "text", text: JSON.stringify(res.output ?? null, null, 2) }], isError: false };
    }
    const err = res.error!;
    const retry = err.retryAfter !== undefined ? ` (retry after ${err.retryAfter}s)` : "";
    return { content: [{ type: "text", text: `Error ${res.status} ${err.code}: ${err.message}${retry}` }], isError: true };
  }

  /** Handle one JSON-RPC message or a batch. Returns undefined when nothing should be sent back. */
  async handle(payload: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    if (Array.isArray(payload)) {
      const out = (await Promise.all(payload.map((m) => this.handleOne(m)))).filter((r): r is JsonRpcResponse => r !== undefined);
      return out.length ? out : undefined;
    }
    return this.handleOne(payload);
  }

  private async handleOne(raw: unknown): Promise<JsonRpcResponse | undefined> {
    const msg = raw as JsonRpcRequest;
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      // Responses from the client (to server requests we never send) are ignored.
      if (msg && typeof msg === "object" && "id" in msg && ("result" in msg || "error" in msg)) return undefined;
      return { jsonrpc: "2.0", id: (msg as any)?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
    }
    const isNotification = msg.id === undefined;
    const reply = (result: unknown): JsonRpcResponse | undefined => (isNotification ? undefined : { jsonrpc: "2.0", id: msg.id ?? null, result });
    const fail = (code: number, message: string): JsonRpcResponse | undefined => (isNotification ? undefined : { jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });

    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
        return reply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fakeplane", version: VERSION },
          instructions: `Simulated backends for scenario "${this.getWorld().scenario}". Writes are recorded, not sent anywhere.`,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: this.listTools() });
      case "tools/call": {
        const name = msg.params?.name;
        if (typeof name !== "string") return fail(-32602, "Missing tool name");
        const result = await this.callTool(name, msg.params?.arguments ?? {});
        if (!result) return fail(-32602, `Unknown tool: ${name}`);
        return reply(result);
      }
      case "resources/list":
        return reply({ resources: [] });
      case "prompts/list":
        return reply({ prompts: [] });
      default:
        if (msg.method.startsWith("notifications/")) return undefined;
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }
}

/** Serve MCP over stdio (newline-delimited JSON-RPC). Resolves when stdin closes. */
export function serveStdio(handler: McpHandler, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, crlfDelay: Infinity });
    let pending = Promise.resolve();
    rl.on("line", (line) => {
      if (!line.trim()) return;
      pending = pending.then(async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
          return;
        }
        const res = await handler.handle(parsed);
        if (res !== undefined) output.write(JSON.stringify(res) + "\n");
      });
    });
    rl.on("close", () => {
      pending.then(() => resolve());
    });
  });
}
