import { ApiError, type JsonObject, type JsonSchema } from "../types.js";
import type { Backend, HttpRoute, Operation, OpContext, World } from "../world.js";
import { matchValue } from "../matchers.js";
import { isPlainObject, renderTemplate } from "../util.js";
import { IDEMPOTENCY_KEY, obj, required, str } from "./common.js";

export interface RejectRule {
  /** Matched against the input (for routes: `{ params, query, body }` merged with body fields). */
  when: JsonObject;
  status?: number;
  code?: string;
  message?: string;
}

export interface CustomRoute {
  method?: string;
  path: string;
  name?: string;
  status?: number;
  /** Static or templated (`{{body.amount}}`, `{{params.id}}`, `{{id}}`, `{{now}}`) response body. */
  response?: unknown;
  /** Record a side effect of this kind (prefixed with `generic.`). Defaults to the route name for non-GET routes. */
  effect?: string;
  reject?: RejectRule[];
}

export interface CustomTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  /** Back the tool with a collection instead of a canned response. */
  collection?: string;
  action?: "get" | "list" | "create" | "update" | "delete";
  /** Input field holding the record id for get/update/delete. Default `id`. */
  id_field?: string;
  response?: unknown;
  /** Responses returned in order, one per call; the last one repeats. Overrides `response`. */
  responses?: unknown[];
  /** Mark as a write and record a side effect of this kind (prefixed with `generic.`). */
  effect?: string;
  write?: boolean;
  reject?: RejectRule[];
}

export interface GenericSeed {
  collections?: Record<string, JsonObject[]>;
  routes?: CustomRoute[];
  tools?: CustomTool[];
  /** Expose generic_list/get/create/update/delete as MCP tools. Default: true when collections are seeded. */
  collection_tools?: boolean;
}

export class GenericBackend implements Backend {
  readonly name = "generic";
  readonly mounts = [{ prefix: "/generic", strip: true }];
  private collections = new Map<string, Map<string, JsonObject>>();
  private readonly customRoutes: CustomRoute[];
  private readonly customTools: CustomTool[];
  private readonly exposeCollectionTools: boolean;

  constructor(
    private readonly world: World,
    seed: GenericSeed = {},
  ) {
    for (const [name, records] of Object.entries(seed.collections ?? {})) {
      const map = new Map<string, JsonObject>();
      for (const r of records) {
        const id = String(r.id ?? `${name}_${world.next(`generic.${name}`)}`);
        map.set(id, { ...r, id: r.id ?? id });
      }
      this.collections.set(name, map);
    }
    this.customRoutes = seed.routes ?? [];
    this.customTools = seed.tools ?? [];
    this.exposeCollectionTools = seed.collection_tools ?? this.collections.size > 0;
  }

  private coll(name: unknown, create = false): Map<string, JsonObject> {
    const key = String(name ?? "");
    let c = this.collections.get(key);
    if (!c && create) {
      c = new Map();
      this.collections.set(key, c);
    }
    if (!c) throw new ApiError(404, "not_found", `Collection ${key} not found`);
    return c;
  }

  private record(collection: unknown, id: unknown): JsonObject {
    const r = this.coll(collection).get(String(id));
    if (!r) throw new ApiError(404, "not_found", `${String(collection)}/${String(id)} not found`);
    return r;
  }

  private create(ctx: OpContext, collection: string, data: JsonObject): JsonObject {
    const c = this.coll(collection, true);
    const id = String(data.id ?? `${collection}_${this.world.next(`generic.${collection}`)}`);
    if (c.has(id)) throw new ApiError(409, "conflict", `${collection}/${id} already exists`);
    const rec = { ...data, id: data.id ?? id, created_at: ctx.now() };
    c.set(id, rec);
    ctx.effect(`generic.${collection}.create`, { ...rec }, collection);
    return { ...rec };
  }

  private update(ctx: OpContext, collection: string, id: string, data: JsonObject): JsonObject {
    const rec = this.record(collection, id);
    Object.assign(rec, data, { id: rec.id, updated_at: ctx.now() });
    ctx.effect(`generic.${collection}.update`, { id, changes: data }, `${collection}:${id}`);
    return { ...rec };
  }

  private remove(ctx: OpContext, collection: string, id: string): JsonObject {
    this.record(collection, id);
    this.coll(collection).delete(id);
    ctx.effect(`generic.${collection}.delete`, { id }, `${collection}:${id}`);
    return { id, deleted: true };
  }

  operations(): Operation[] {
    const b = "generic";
    const expose = this.exposeCollectionTools;
    const collectionOps: Operation[] = [
      {
        id: "generic.list",
        backend: b,
        write: false,
        tool: expose ? { name: "generic_list", description: `List records in a collection (${[...this.collections.keys()].join(", ")}). Optional exact-match filter.`, inputSchema: obj({ collection: str("Collection name"), where: { type: "object", description: "Field filter" } }, ["collection"]) } : undefined,
        run: (input: JsonObject) => [...this.coll(required(input, "collection")).values()].filter((r) => !input.where || matchValue(r, input.where).ok).map((r) => ({ ...r })),
      },
      {
        id: "generic.get",
        backend: b,
        write: false,
        tool: expose ? { name: "generic_get", description: "Get one record by id.", inputSchema: obj({ collection: str("Collection name"), id: str("Record id") }, ["collection", "id"]) } : undefined,
        run: (input: JsonObject) => ({ ...this.record(required(input, "collection"), required(input, "id")) }),
      },
      {
        id: "generic.create",
        backend: b,
        write: true,
        tool: expose ? { name: "generic_create", description: "Create a record.", inputSchema: obj({ collection: str("Collection name"), data: { type: "object", description: "Record fields" }, idempotency_key: IDEMPOTENCY_KEY }, ["collection", "data"]) } : undefined,
        run: (input: JsonObject, ctx) => this.create(ctx, String(required(input, "collection")), (input.data as JsonObject) ?? {}),
      },
      {
        id: "generic.update",
        backend: b,
        write: true,
        tool: expose ? { name: "generic_update", description: "Merge fields into a record.", inputSchema: obj({ collection: str("Collection name"), id: str("Record id"), data: { type: "object", description: "Fields to set" }, idempotency_key: IDEMPOTENCY_KEY }, ["collection", "id", "data"]) } : undefined,
        run: (input: JsonObject, ctx) => this.update(ctx, String(required(input, "collection")), String(required(input, "id")), (input.data as JsonObject) ?? {}),
      },
      {
        id: "generic.delete",
        backend: b,
        write: true,
        tool: expose ? { name: "generic_delete", description: "Delete a record.", inputSchema: obj({ collection: str("Collection name"), id: str("Record id"), idempotency_key: IDEMPOTENCY_KEY }, ["collection", "id"]) } : undefined,
        run: (input: JsonObject, ctx) => this.remove(ctx, String(required(input, "collection")), String(required(input, "id"))),
      },
    ];

    const routeOps: Operation[] = this.customRoutes.map((route) => {
      const method = (route.method ?? "GET").toUpperCase();
      const name = route.name ?? `${method} ${route.path}`;
      const write = method !== "GET" || route.effect !== undefined;
      return {
        id: `generic.route.${name}`,
        backend: b,
        write,
        run: (input: { params: JsonObject; query: JsonObject; body: unknown }, ctx: OpContext) => {
          const flat = { ...(isPlainObject(input.body) ? input.body : {}), params: input.params, query: input.query };
          applyRejects(route.reject, flat);
          const id = `${slugify(name)}_${this.world.next(`generic.route.${name}`)}`;
          if (write) ctx.effect(`generic.${route.effect ?? slugify(name)}`, isPlainObject(input.body) ? { ...input.body, params: input.params } : { body: input.body, params: input.params });
          const vars = { ...input, input: flat, id, now: ctx.now() };
          return route.response === undefined ? { ok: true, id } : renderTemplate(route.response, vars);
        },
      };
    });

    const toolOps: Operation[] = this.customTools.map((tool) => {
      const write = tool.write ?? (tool.effect !== undefined || ["create", "update", "delete"].includes(tool.action ?? ""));
      return {
        id: `generic.tool.${tool.name}`,
        backend: b,
        write,
        tool: {
          name: tool.name,
          description: tool.description ?? `Custom tool ${tool.name}`,
          inputSchema: withIdempotency(tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: true }, write),
        },
        run: (input: JsonObject = {}, ctx: OpContext) => {
          applyRejects(tool.reject, input);
          const { idempotency_key: _k, ...data } = input;
          const idField = tool.id_field ?? "id";
          let result: unknown;
          if (tool.collection) {
            const action = tool.action ?? "get";
            if (action === "list") result = [...this.coll(tool.collection, true).values()].filter((r) => matchValue(r, data).ok).map((r) => ({ ...r }));
            else if (action === "get") result = { ...this.record(tool.collection, required(data, idField)) };
            else if (action === "create") result = this.create(ctx, tool.collection, data);
            else if (action === "update") {
              const { [idField]: id, ...rest } = data;
              result = this.update(ctx, tool.collection, String(required(data, idField)), rest as JsonObject);
              void id;
            } else result = this.remove(ctx, tool.collection, String(required(data, idField)));
            if (tool.effect) ctx.effect(`generic.${tool.effect}`, data);
          } else if (write) {
            ctx.effect(`generic.${tool.effect ?? tool.name}`, data);
          }
          const callNo = this.world.next(`generic.tool.${tool.name}`);
          const canned = tool.responses?.length ? tool.responses[Math.min(callNo, tool.responses.length) - 1] : tool.response;
          if (canned !== undefined) {
            return renderTemplate(canned, { input: data, result, now: ctx.now(), id: `${tool.name}_${callNo}` });
          }
          return result ?? { ok: true };
        },
      };
    });

    return [...collectionOps, ...routeOps, ...toolOps];
  }

  /** Custom routes, which are also served at their literal path outside `/generic`. */
  fallbackRoutes(): HttpRoute[] {
    return this.customRoutes.map((route) => {
      const method = (route.method ?? "GET").toUpperCase();
      const name = route.name ?? `${method} ${route.path}`;
      return {
        method,
        path: route.path,
        op: `generic.route.${name}`,
        toInput: (r) => ({ params: r.params, query: r.query, body: r.body }),
        toResponse: (res) => ({ status: route.status ?? (method === "POST" ? 201 : 200), body: res }),
      };
    });
  }

  routes(): HttpRoute[] {
    return [
      ...this.fallbackRoutes(),
      { method: "GET", path: "/:collection", op: "generic.list", toInput: (r) => ({ collection: r.params.collection, where: Object.keys(r.query).length ? r.query : undefined }), toResponse: (res) => ({ body: { data: res } }) },
      { method: "GET", path: "/:collection/:id", op: "generic.get", toInput: (r) => ({ collection: r.params.collection, id: r.params.id }) },
      { method: "POST", path: "/:collection", op: "generic.create", toInput: (r) => ({ collection: r.params.collection, data: r.body ?? {} }), toResponse: (res) => ({ status: 201, body: res }) },
      { method: "PATCH", path: "/:collection/:id", op: "generic.update", toInput: (r) => ({ collection: r.params.collection, id: r.params.id, data: r.body ?? {} }) },
      { method: "PUT", path: "/:collection/:id", op: "generic.update", toInput: (r) => ({ collection: r.params.collection, id: r.params.id, data: r.body ?? {} }) },
      { method: "DELETE", path: "/:collection/:id", op: "generic.delete", toInput: (r) => ({ collection: r.params.collection, id: r.params.id }) },
    ];
  }

  errorResponse(err: ApiError) {
    const headers: Record<string, string> = err.retryAfter !== undefined ? { "Retry-After": String(err.retryAfter) } : {};
    return { status: err.status, body: { error: { code: err.code, message: err.message } }, headers };
  }

  snapshot() {
    const out: Record<string, unknown> = {};
    for (const [name, c] of this.collections) out[name] = Object.fromEntries([...c].map(([id, r]) => [id, { ...r }]));
    return { collections: out };
  }
}

function applyRejects(rules: RejectRule[] | undefined, input: unknown): void {
  for (const rule of rules ?? []) {
    if (matchValue(input, rule.when).ok) {
      throw new ApiError(rule.status ?? 422, rule.code ?? "rejected", rule.message ?? "Request rejected");
    }
  }
}

function withIdempotency(schema: JsonSchema, write: boolean): JsonSchema {
  if (!write || schema.type !== "object") return schema;
  return { ...schema, properties: { ...(schema.properties ?? {}), idempotency_key: IDEMPOTENCY_KEY } };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}
