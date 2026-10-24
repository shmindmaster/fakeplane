import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpHandler } from "./mcp.js";
import type { Backend, HttpReply, HttpRequestInfo, HttpRoute, World } from "./world.js";
import { ApiError } from "./types.js";
import { VERSION } from "./version.js";

const MAX_BODY = 5 * 1024 * 1024;

export interface ControlHooks {
  /** Rebuild the world from its seed. */
  reset?: () => World;
  /** Evaluate assertions against the current world (used by `fakeplane report --assert`). */
  assert?: (world: World, assertions: unknown[]) => unknown | Promise<unknown>;
  /** Apply a user turn to the world and return the event the agent would receive. */
  injectTurn?: (world: World, turn: Record<string, unknown>) => unknown;
}

export interface FakeServerOptions {
  host?: string;
  port?: number;
  hooks?: ControlHooks;
}

export interface ServerUrls {
  base: string;
  mcp: string;
  zendesk: string;
  slack: string;
  linear: string;
  generic: string;
}

export class FakeServer {
  world: World;
  readonly mcp: McpHandler;
  private server?: Server;
  private readonly hooks: ControlHooks;
  private readonly options: FakeServerOptions;

  constructor(world: World, options: FakeServerOptions = {}) {
    this.world = world;
    this.options = options;
    this.hooks = options.hooks ?? {};
    this.mcp = new McpHandler(() => this.world);
  }

  async start(): Promise<ServerUrls> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { error: { code: "fakeplane_error", message: err instanceof Error ? err.message : String(err) } });
        else res.end();
      });
    });
    const host = this.options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.port ?? 0, host, () => resolve());
    });
    return this.urls();
  }

  urls(): ServerUrls {
    const addr = this.server?.address() as AddressInfo | null;
    if (!addr) throw new Error("Server not started");
    const host = addr.address === "::" || addr.address === "0.0.0.0" ? "127.0.0.1" : addr.address.includes(":") ? `[${addr.address}]` : addr.address;
    const base = `http://${host}:${addr.port}`;
    return { base, mcp: `${base}/mcp`, zendesk: `${base}/zendesk`, slack: `${base}/slack/api`, linear: `${base}/linear/graphql`, generic: `${base}/generic` };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fakeplane.local");
    let path = decodeURIComponent(url.pathname).replace(/\/+$/, "") || "/";
    const method = (req.method ?? "GET").toUpperCase();
    const query: Record<string, string> = Object.fromEntries(url.searchParams);
    const body = await readBody(req);

    if (path === "/_fakeplane" || path.startsWith("/_fakeplane/")) return this.control(method, path.slice("/_fakeplane".length) || "/", body, res);
    if (path === "/mcp") return this.handleMcp(method, body, res);
    if (path === "/") return sendJson(res, 200, { name: "fakeplane", version: VERSION, scenario: this.world.scenario, urls: this.urls() });

    if (path.endsWith(".json")) path = path.slice(0, -5);
    const reqInfo = (p: string, params: Record<string, string> = {}): HttpRequestInfo => ({ method, path: p, params, query, body, headers: req.headers });

    const mounts: { backend: Backend; prefix: string; strip: boolean }[] = [];
    for (const backend of this.world.backends.values()) for (const m of backend.mounts) mounts.push({ backend, ...m });
    mounts.sort((a, b) => b.prefix.length - a.prefix.length);

    for (const { backend, prefix, strip } of mounts) {
      if (path !== prefix && !path.startsWith(prefix + "/")) continue;
      const sub = strip ? path.slice(prefix.length) || "/" : path;
      const reply = await this.tryBackend(backend, backend.routes(), reqInfo(sub), req);
      if (reply) return this.send(res, reply);
    }
    for (const backend of this.world.backends.values()) {
      const routes = backend.fallbackRoutes?.();
      if (!routes?.length) continue;
      const reply = await this.tryBackend(backend, routes, reqInfo(path), req, false);
      if (reply) return this.send(res, reply);
    }
    sendJson(res, 404, { error: { code: "no_route", message: `fakeplane has no fake for ${method} ${path}` } });
  }

  private async tryBackend(backend: Backend, routes: HttpRoute[], info: HttpRequestInfo, req: IncomingMessage, allowCustom = true): Promise<HttpReply | undefined> {
    const idempotencyKey = header(req, "idempotency-key");
    for (const route of routes) {
      if (route.method !== info.method) continue;
      const params = matchPath(route.path, info.path);
      if (!params) continue;
      const withParams = { ...info, params };
      let input: unknown;
      try {
        input = route.toInput(withParams);
      } catch (err) {
        if (err instanceof ApiError) return backend.errorResponse(err);
        throw err;
      }
      const result = await this.world.dispatch(route.op, input, { transport: "http", idempotencyKey });
      if (result.drop) return { status: 0, body: null, drop: true };
      if (result.error) return backend.errorResponse(result.error);
      const shaped = route.toResponse ? route.toResponse(result.output, withParams) : { body: result.output };
      return { status: shaped.status ?? 200, body: shaped.body };
    }
    if (allowCustom && backend.handleHttp) {
      return backend.handleHttp(info, (op, input) => this.world.dispatch(op, input, { transport: "http", idempotencyKey }));
    }
    return undefined;
  }

  private send(res: ServerResponse, reply: HttpReply): void {
    if (reply.drop) {
      res.socket?.destroy();
      return;
    }
    sendJson(res, reply.status, reply.body, reply.headers);
  }

  private async handleMcp(method: string, body: unknown, res: ServerResponse): Promise<void> {
    if (method === "GET") {
      res.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }
    if (method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (method !== "POST") {
      res.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }
    if (body === undefined || typeof body === "string") {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const out = await this.mcp.handle(body);
    if (out === undefined) {
      res.writeHead(202).end();
      return;
    }
    sendJson(res, 200, out);
  }

  private async control(method: string, path: string, body: any, res: ServerResponse): Promise<void> {
    const w = this.world;
    const route = `${method} ${path}`;
    switch (route) {
      case "GET /":
      case "GET /health":
        return sendJson(res, 200, { ok: true, scenario: w.scenario, version: VERSION, calls: w.calls.length, effects: w.effects.length });
      case "GET /state":
        return sendJson(res, 200, w.snapshot());
      case "GET /calls":
        return sendJson(res, 200, w.calls);
      case "GET /effects":
        return sendJson(res, 200, w.effects);
      case "GET /report":
        return sendJson(res, 200, { scenario: w.scenario, calls: w.calls, effects: w.effects, state: w.snapshot() });
      case "POST /reset":
        if (!this.hooks.reset) return sendJson(res, 501, { error: { code: "unsupported", message: "reset not available" } });
        this.world = this.hooks.reset();
        return sendJson(res, 200, { ok: true });
      case "POST /faults":
        w.setFaults(Array.isArray(body?.faults) ? body.faults : []);
        return sendJson(res, 200, { ok: true });
      case "POST /assert":
        if (!this.hooks.assert) return sendJson(res, 501, { error: { code: "unsupported", message: "assert not available" } });
        try {
          return sendJson(res, 200, await this.hooks.assert(w, Array.isArray(body?.assert) ? body.assert : []));
        } catch (err) {
          return sendJson(res, 400, { error: { code: "bad_assertions", message: err instanceof Error ? err.message : String(err) } });
        }
      case "POST /turn":
        if (!this.hooks.injectTurn) return sendJson(res, 501, { error: { code: "unsupported", message: "turn injection not available" } });
        try {
          return sendJson(res, 200, this.hooks.injectTurn(w, body ?? {}));
        } catch (err) {
          return sendJson(res, 400, { error: { code: "bad_turn", message: err instanceof Error ? err.message : String(err) } });
        }
      default:
        return sendJson(res, 404, { error: { code: "no_route", message: `Unknown control endpoint ${route}` } });
    }
  }
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) params[p[i].slice(1)] = s[i];
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ApiError(413, "too_large", "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  const type = String(req.headers["content-type"] ?? "");
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}
