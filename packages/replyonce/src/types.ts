export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Lifecycle of one effect in the ledger.
 *
 * - `pending`: an attempt claimed the key and may be executing right now.
 * - `committed`: the effect is known to have happened. It is never run again.
 * - `failed`: the effect is known NOT to have happened. A later call may retry.
 * - `ambiguous`: it may or may not have happened (timeout, crash, unknown error).
 *   It is never retried blindly; it must be reconciled.
 */
export type EffectStatus = 'pending' | 'committed' | 'failed' | 'ambiguous';

export interface EffectRecord {
  key: string;
  scope: string;
  intent: string;
  status: EffectStatus;
  attempt: number;
  attemptId: string;
  runId: string | null;
  token: number | null;
  summary: string | null;
  result?: Json;
  error: string | null;
  createdAt: number;
  claimedAt: number;
  settledAt: number | null;
  /** Scope sequence number of the claim and of the last settlement (logical clock). */
  claimSeq: number;
  settleSeq: number | null;
}

/**
 * `supersede`: the newest run on a scope owns it; older runs are refused at write time.
 * `exclusive`: one live lease holder at a time; a second `begin` is told the scope is busy
 *   until the lease expires.
 */
export type RunMode = 'supersede' | 'exclusive';
export type RunEndReason = 'completed' | 'failed' | 'cancelled';

export interface RunRecord {
  runId: string;
  token: number;
  mode: RunMode;
  startedAt: number;
  /** Supersession order: when this run's context was read. Newer context owns the scope. */
  orderAt: number;
  leaseExpiresAt: number;
  /** The run has seen every write settled at or before this scope sequence number. */
  seenSeq: number;
  /** Wall-clock time of the same moment, used only against TTL-based abandonment. */
  seenAt: number;
  /** Until the run's first claim or ack: writes settled at or after this time are unseen. */
  contextAt: number | null;
  /** The run's original context, restored when a redelivery takes the run over. */
  baseSeq: number;
  baseContextAt: number | null;
  wrote: boolean;
  endedAt: number | null;
  endReason: RunEndReason | null;
}

/** Everything replyonce knows about one scope (usually one conversation or thread). */
export interface ScopeState {
  v: 1;
  /** Logical clock, incremented on every change to the scope. */
  seq: number;
  tokenSeq: number;
  runs: Record<string, RunRecord>;
  effects: Record<string, EffectRecord>;
}

export interface TransactResult<T> {
  /** New state to persist, or `null` to leave the stored state unchanged. */
  next: ScopeState | null;
  result: T;
}

/**
 * A store gives atomic read-modify-write over one scope's state. That is the only
 * primitive replyonce needs; all decision logic lives in the library.
 */
export interface Store {
  /**
   * Atomically apply `fn` to the scope's current state. `fn` is synchronous and pure,
   * and a store may call it more than once (optimistic retries).
   */
  transact<T>(scope: string, fn: (state: ScopeState | null) => TransactResult<T>): Promise<T>;
  read(scope: string): Promise<ScopeState | null>;
}

export type RefusalReason =
  | 'superseded'
  | 'run_cancelled'
  | 'run_ended'
  | 'unknown_run'
  | 'busy'
  | 'conversation_changed'
  | 'exhausted';

export interface ConflictInfo {
  key: string;
  intent: string;
  status: EffectStatus;
  runId: string | null;
  summary: string | null;
  at: number;
}

export interface EffectContext {
  key: string;
  scope: string;
  intent: string;
  attempt: number;
  /** Stable across attempts and workers. Pass it to providers that accept an idempotency key. */
  idempotencyKey: string;
  /** Fencing token of the run that claimed this effect, or `null` outside a run. */
  fencingToken: number | null;
  /** Aborts when the claim would be treated as abandoned (`pendingTtlMs`). */
  signal: AbortSignal;
}

export type OnceResult<T> =
  | { status: 'executed'; ok: true; value: T; key: string; attempt: number; lateSettle?: true }
  | { status: 'replayed'; ok: true; value: T; key: string; entry: EffectRecord }
  | { status: 'in_flight'; ok: false; key: string; entry: EffectRecord }
  | { status: 'ambiguous'; ok: false; key: string; entry: EffectRecord; error?: unknown }
  | { status: 'failed'; ok: false; key: string; attempt: number; error: unknown; retryable: boolean }
  | {
      status: 'refused';
      ok: false;
      key: string;
      reason: RefusalReason;
      conflicts?: ConflictInfo[];
      entry?: EffectRecord;
    };

export type ReconcileVerdict =
  | { outcome: 'committed'; result?: Json }
  | { outcome: 'not_applied' }
  | { outcome: 'unknown' };

export type ErrorClass = 'not_applied' | 'ambiguous';

export type ReplyOnceEvent =
  | { type: 'claimed'; scope: string; key: string; attempt: number; runId: string | null }
  | { type: 'committed'; scope: string; key: string; attempt: number; runId: string | null }
  | { type: 'replayed'; scope: string; key: string }
  | { type: 'in_flight'; scope: string; key: string }
  | { type: 'failed'; scope: string; key: string; attempt: number; error: unknown }
  | { type: 'ambiguous'; scope: string; key: string; error?: unknown }
  | { type: 'refused'; scope: string; key: string; reason: RefusalReason; runId: string | null }
  | { type: 'reconciled'; scope: string; key: string; outcome: ReconcileVerdict['outcome'] }
  | { type: 'late_settle'; scope: string; key: string; attempt: number }
  | { type: 'unserializable_result'; scope: string; key: string };
