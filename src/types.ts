export type JsonObject = Record<string, unknown>;

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

/** An error a fake backend returns to the caller, with an HTTP status. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfter?: number;

  constructor(status: number, code: string, message: string, options: { details?: unknown; retryAfter?: number } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
  }
}

export type Transport = "http" | "mcp" | "api";

/** One request an agent made to a fake backend. */
export interface CallRecord {
  seq: number;
  at: string;
  transport: Transport;
  backend: string;
  op: string;
  tool?: string;
  turn?: number;
  input: unknown;
  ok: boolean;
  status: number;
  output?: unknown;
  error?: { code: string; message: string };
  fault?: string;
  /** True when the operation's write committed, even if the caller saw an error. */
  committed: boolean;
  idempotencyKey?: string;
  /** True when the response came from the idempotency cache and nothing new was written. */
  replayed?: boolean;
  effects: number[];
}

/** A side effect the agent would have caused in the real system. */
export interface Effect {
  seq: number;
  at: string;
  kind: string;
  backend: string;
  target?: string;
  data: JsonObject;
  callSeq: number;
  turn?: number;
}

export interface TurnRecord {
  turn: number;
  delivery: number;
  deliveryId: string;
  via: string;
  text?: string;
  event: JsonObject;
  output: string;
  error?: string;
  durationMs: number;
}
