import { ApiError, type CallRecord, type Effect, type JsonObject, type JsonSchema, type Transport } from "./types.js";
import { matchValue } from "./matchers.js";
import { clone, globMatch, sleep } from "./util.js";

export interface OpContext {
  world: World;
  /** Record a side effect the real system would have performed. */
  effect(kind: string, data: JsonObject, target?: string): void;
  now(): string;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface Operation {
  /** Stable id, e.g. `zendesk.ticket.update`. Used by faults and `calls` assertions. */
  id: string;
  backend: string;
  write: boolean;
  /** Exposed as an MCP tool when present. */
  tool?: ToolSpec;
  run(input: any, ctx: OpContext): unknown | Promise<unknown>;
}

export interface HttpRequestInfo {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

export interface HttpRoute {
  method: string;
  /** Path pattern relative to the backend mount, with `:param` segments. */
  path: string;
  op: string;
  toInput(req: HttpRequestInfo): unknown;
  /** Shape a successful result as the real API would. Defaults to 200 + result as JSON. */
  toResponse?(result: unknown, req: HttpRequestInfo): { status?: number; body: unknown };
}

export interface HttpReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  drop?: boolean;
}

export interface TurnInjection {
  via: string;
  text?: string;
  [key: string]: unknown;
}

export interface Backend {
  name: string;
  /** URL prefixes this backend answers on, e.g. `/zendesk` (prefixed) and `/api/v2` (bare). */
  mounts: { prefix: string; strip: boolean }[];
  operations(): Operation[];
  routes(): HttpRoute[];
  /** Routes also served at their literal path when no backend mount matches. */
  fallbackRoutes?(): HttpRoute[];
  /** Optional custom HTTP handling (e.g. GraphQL) for paths that `routes()` doesn't cover. Return undefined to fall through. */
  handleHttp?(req: HttpRequestInfo, dispatch: (op: string, input: unknown) => Promise<DispatchResult>): Promise<HttpReply | undefined>;
  snapshot(): unknown;
  /** Shape an error the way this API does (Slack returns 200 + ok:false, etc.). */
  errorResponse(err: ApiError): { status: number; body: unknown; headers?: Record<string, string> };
  /** Apply an inbound user turn (customer message, Slack post) and return the event the agent receives. */
  injectTurn?(turn: TurnInjection, ctx: { world: World; deliveryId: string }): JsonObject;
  /** Data to scan for PII-shaped values that come from the seed (used by `no_pii: { seeded: true }`). */
  seededSensitiveValues?(): string[];
}

export type FaultKind = "timeout" | "rate_limit" | "error" | "partial" | "latency";

export interface FaultSpec {
  /** Operation id or MCP tool name glob, e.g. `zendesk.ticket.*` or `slack_post_message`. */
  op?: string;
  backend?: string;
  /** Match on the operation input. */
  where?: JsonObject;
  kind: FaultKind;
  /** Skip this many matching calls before the fault starts firing. */
  after?: number;
  /** How many times to fire. Default 1. `always` fires on every match. */
  times?: number | "always";
  status?: number;
  delayMs?: number;
  retryAfter?: number;
  /** Whether the write still commits when the caller sees the failure. Default: true for `partial`, false otherwise. */
  committed?: boolean;
  /** HTTP only: close the socket instead of answering (the client sees a connection reset). */
  drop?: boolean;
  message?: string;
}

interface FaultState {
  spec: FaultSpec;
  seen: number;
  fired: number;
}

export interface DispatchMeta {
  transport: Transport;
  idempotencyKey?: string;
  tool?: string;
}

export interface DispatchResult {
  ok: boolean;
  status: number;
  output?: unknown;
  error?: ApiError;
  call: CallRecord;
  drop?: boolean;
}

export interface WorldOptions {
  scenario?: string;
  clock?: string;
  faults?: FaultSpec[];
}

export class World {
  readonly scenario: string;
  readonly calls: CallRecord[] = [];
  readonly effects: Effect[] = [];
  readonly backends = new Map<string, Backend>();
  currentTurn: number | undefined;
  private readonly ops = new Map<string, Operation>();
  private readonly toolIndex = new Map<string, Operation>();
  private faults: FaultState[];
  private readonly idempotency = new Map<string, { status: number; ok: boolean; output?: unknown; error?: ApiError }>();
  private clockMs: number;
  private counters = new Map<string, number>();

  constructor(options: WorldOptions = {}) {
    this.scenario = options.scenario ?? "default";
    this.clockMs = Date.parse(options.clock ?? "2026-01-01T00:00:00.000Z");
    if (Number.isNaN(this.clockMs)) throw new Error(`Invalid clock: ${options.clock}`);
    this.faults = (options.faults ?? []).map((spec) => ({ spec, seen: 0, fired: 0 }));
  }

  addBackend(backend: Backend): void {
    this.backends.set(backend.name, backend);
    for (const op of backend.operations()) {
      this.ops.set(op.id, op);
      if (op.tool) this.toolIndex.set(op.tool.name, op);
    }
  }

  operation(idOrTool: string): Operation | undefined {
    return this.ops.get(idOrTool) ?? this.toolIndex.get(idOrTool);
  }

  operations(): Operation[] {
    return [...this.ops.values()];
  }

  tools(): Operation[] {
    return [...this.toolIndex.values()];
  }

  /** Deterministic virtual clock: each call advances it by one second. */
  now(): string {
    return new Date(this.clockMs).toISOString();
  }

  tick(ms = 1000): void {
    this.clockMs += ms;
  }

  nowMs(): number {
    return this.clockMs;
  }

  /** Deterministic counter per namespace (ids, timestamps). */
  next(namespace: string, start = 1): number {
    const value = (this.counters.get(namespace) ?? start - 1) + 1;
    this.counters.set(namespace, value);
    return value;
  }

  bumpCounter(namespace: string, atLeast: number): void {
    if ((this.counters.get(namespace) ?? 0) < atLeast) this.counters.set(namespace, atLeast);
  }

  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, backend] of this.backends) out[name] = backend.snapshot();
    return out;
  }

  setFaults(faults: FaultSpec[]): void {
    this.faults = faults.map((spec) => ({ spec, seen: 0, fired: 0 }));
  }

  private matchFault(op: Operation, input: unknown): FaultSpec | undefined {
    for (const state of this.faults) {
      const { spec } = state;
      if (spec.backend && spec.backend !== op.backend) continue;
      if (spec.op && !globMatch(spec.op, op.id) && !(op.tool && globMatch(spec.op, op.tool.name))) continue;
      if (spec.where && !matchValue(input, spec.where).ok) continue;
      state.seen += 1;
      if (state.seen <= (spec.after ?? 0)) continue;
      const times = spec.times ?? 1;
      if (times !== "always" && state.fired >= times) continue;
      state.fired += 1;
      return spec;
    }
    return undefined;
  }

  /** Run an operation the way a real backend would, applying faults and recording everything. */
  async dispatch(opId: string, input: unknown, meta: DispatchMeta): Promise<DispatchResult> {
    const op = this.operation(opId);
    this.tick();
    const call: CallRecord = {
      seq: this.calls.length + 1,
      at: this.now(),
      transport: meta.transport,
      backend: op?.backend ?? "unknown",
      op: op?.id ?? opId,
      tool: meta.tool ?? op?.tool?.name,
      turn: this.currentTurn,
      input: clone(input),
      ok: false,
      status: 0,
      committed: false,
      idempotencyKey: meta.idempotencyKey,
      effects: [],
    };
    this.calls.push(call);

    const finish = (status: number, output?: unknown, error?: ApiError, drop?: boolean): DispatchResult => {
      call.status = status;
      call.ok = !error && status < 400;
      if (output !== undefined) call.output = clone(output);
      if (error) call.error = { code: error.code, message: error.message };
      return { ok: call.ok, status, output, error, call, drop };
    };

    if (!op) return finish(404, undefined, new ApiError(404, "unknown_operation", `No fake operation ${opId}`));

    const idemKey = op.write && meta.idempotencyKey ? `${op.id}\u0000${meta.idempotencyKey}` : undefined;
    if (idemKey && this.idempotency.has(idemKey)) {
      const cached = this.idempotency.get(idemKey)!;
      call.replayed = true;
      return finish(cached.status, cached.output, cached.error);
    }

    const fault = this.matchFault(op, input);
    if (fault) call.fault = fault.kind;
    const committed = fault ? (fault.committed ?? fault.kind === "partial") : true;
    if (fault?.delayMs) await sleep(fault.delayMs);

    if (fault && fault.kind !== "latency" && !committed) {
      return finish(...faultError(fault), fault.drop);
    }

    const ctx: OpContext = {
      world: this,
      now: () => this.now(),
      effect: (kind, data, target) => {
        const effect: Effect = {
          seq: this.effects.length + 1,
          at: this.now(),
          kind,
          backend: op.backend,
          target,
          data: clone(data),
          callSeq: call.seq,
          turn: this.currentTurn,
        };
        this.effects.push(effect);
        call.effects.push(effect.seq);
      },
    };

    let result: DispatchResult;
    try {
      const output = await op.run(clone(input), ctx);
      call.committed = op.write;
      result = fault && fault.kind !== "latency" ? finish(...faultError(fault), fault.drop) : finish(200, output);
    } catch (err) {
      const apiErr =
        err instanceof ApiError ? err : new ApiError(500, "internal_error", err instanceof Error ? err.message : String(err));
      result = finish(apiErr.status, undefined, apiErr);
    }
    if (idemKey && (result.ok || call.committed)) {
      this.idempotency.set(idemKey, { status: result.status, ok: result.ok, output: result.output, error: result.error });
    }
    return result;
  }
}

function faultError(fault: FaultSpec): [number, undefined, ApiError] {
  switch (fault.kind) {
    case "timeout":
      return [fault.status ?? 504, undefined, new ApiError(fault.status ?? 504, "timeout", fault.message ?? "Upstream request timed out")];
    case "rate_limit": {
      const retryAfter = fault.retryAfter ?? 1;
      return [
        fault.status ?? 429,
        undefined,
        new ApiError(fault.status ?? 429, "rate_limited", fault.message ?? `Rate limit exceeded. Retry after ${retryAfter}s`, { retryAfter }),
      ];
    }
    case "partial":
      return [fault.status ?? 502, undefined, new ApiError(fault.status ?? 502, "bad_gateway", fault.message ?? "Bad gateway")];
    default:
      return [fault.status ?? 500, undefined, new ApiError(fault.status ?? 500, "server_error", fault.message ?? "Internal server error")];
  }
}
