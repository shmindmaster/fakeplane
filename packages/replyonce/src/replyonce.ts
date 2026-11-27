import { randomUUID } from 'node:crypto';
import { effectKey, providerIdempotencyKey } from './key.js';
import * as logic from './logic.js';
import type { BeginOutcome, ClaimOutcome, ConflictMode, Policy } from './logic.js';
import type {
  EffectContext,
  EffectRecord,
  EffectStatus,
  ErrorClass,
  Json,
  OnceResult,
  ReconcileVerdict,
  ReplyOnceEvent,
  RunEndReason,
  RunMode,
  RunRecord,
  Store,
} from './types.js';

/** Throw this (or anything with `replyonce: 'not_applied'`) when the effect definitely did not happen. */
export class NotApplied extends Error {
  readonly replyonce = 'not_applied' as const;
  constructor(message = 'effect not applied', options?: { cause?: unknown }) {
    super(message);
    this.name = 'NotApplied';
    if (options && 'cause' in options) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function defaultClassifyError(err: unknown): ErrorClass {
  if (err instanceof NotApplied) return 'not_applied';
  if (err && typeof err === 'object' && (err as { replyonce?: unknown }).replyonce === 'not_applied') {
    return 'not_applied';
  }
  return 'ambiguous';
}

export interface KeyParts {
  /** Usually the conversation or thread id. All fencing happens within a scope. */
  scope: string;
  /** What the effect is: `reply`, `refund`, `create_ticket`. */
  intent: string;
  /**
   * The business identity of the effect, hashed into the key. Use what makes it the same
   * action (the inbound message being answered, the order being refunded), never
   * model-generated text or a model tool-call id.
   */
  payload?: unknown;
}

export type Reconciler = (entry: EffectRecord) => Promise<ReconcileVerdict>;

export interface ReplyOnceOptions {
  store: Store;
  /** How long a claim may stay pending before it is treated as abandoned (ambiguous). Default 15 min. */
  pendingTtlMs?: number;
  /** Attempts per key, counting only attempts known not to have applied. Default 3. */
  maxAttempts?: number;
  /** How long settled effects and ended runs are remembered. Default 7 days. */
  retentionMs?: number;
  /** Run lease length; renewed on every claim and heartbeat. Default 60 s. */
  leaseTtlMs?: number;
  /** Decide whether a thrown error means "did not happen" or "might have happened". */
  classifyError?: (err: unknown) => ErrorClass;
  /** Ask the outside world what happened to an ambiguous effect. */
  reconcile?: Reconciler;
  onEvent?: (event: ReplyOnceEvent) => void;
  clock?: () => number;
  /** Wait between settle retries and `wait` polls. Pass with `clock` to run on simulated time. */
  sleep?: (ms: number) => Promise<void>;
}

export interface OnceOptions {
  /** Short human-readable description, shown to other runs in conflict reports. */
  summary?: string;
  classifyError?: (err: unknown) => ErrorClass;
  reconcile?: Reconciler;
  /** Wait for an in-flight duplicate to settle instead of returning `in_flight` immediately. */
  wait?: { timeoutMs: number; intervalMs?: number };
}

export interface RunOnceOptions extends OnceOptions {
  /**
   * `any` (default): refuse if another run wrote anything on this scope since this run last
   * looked. `same-intent`: only effects with the same intent conflict. `none`: per-key
   * idempotency and supersession only.
   */
  conflict?: ConflictMode;
  /** Record that this run has now seen the conflicts, so its next attempt can proceed. Default true. */
  ack?: boolean;
}

export interface CheckResult {
  /** `true` only when the effect is known to have happened. */
  done: boolean;
  status: EffectStatus | 'none';
  entry: EffectRecord | null;
}

export interface BeginOptions {
  /** Stable id for this unit of work. Reuse it on redelivery (for example the queue job id). */
  runId?: string;
  mode?: RunMode;
  leaseTtlMs?: number;
  /**
   * Epoch ms when this run's context (the conversation it will act on) was read, for
   * example when the webhook payload was captured. Writes by other runs that landed
   * after this point are reported as `conversation_changed`. Default: now.
   */
  contextAt?: number;
}

export type Effect<T> = (ctx: EffectContext) => Promise<T> | T;

const MAX_ROUNDS = 5;

export class ReplyOnce {
  readonly store: Store;
  readonly policy: Policy;
  readonly leaseTtlMs: number;
  private readonly classify: (err: unknown) => ErrorClass;
  private readonly reconciler: Reconciler | undefined;
  private readonly emit: (event: ReplyOnceEvent) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ReplyOnceOptions) {
    if (!options || !options.store) throw new TypeError('replyonce: a store is required');
    this.store = options.store;
    this.policy = {
      pendingTtlMs: options.pendingTtlMs ?? 15 * 60_000,
      maxAttempts: options.maxAttempts ?? 3,
      retentionMs: options.retentionMs ?? 7 * 24 * 3_600_000,
    };
    if (this.policy.pendingTtlMs <= 0 || this.policy.maxAttempts < 1 || this.policy.retentionMs <= 0) {
      throw new RangeError('replyonce: pendingTtlMs, maxAttempts and retentionMs must be positive');
    }
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
    this.classify = options.classifyError ?? defaultClassifyError;
    this.reconciler = options.reconcile;
    const onEvent = options.onEvent;
    this.emit = onEvent
      ? (e) => {
          try {
            onEvent(e);
          } catch {
            // an observer must never change the outcome
          }
        }
      : () => {};
    this.now = options.clock ?? Date.now;
    this.sleep = options.sleep ?? sleep;
  }

  /** Resolve key parts to the ledger key used for them. */
  key(parts: KeyParts): string {
    return effectKey(parts.intent, parts.payload);
  }

  /**
   * Run `effect` at most once for this key. A string key is its own scope; key parts give
   * a scope (conversation) plus an intent and business identity.
   */
  once<T>(key: string | KeyParts, effect: Effect<T>, options: OnceOptions = {}): Promise<OnceResult<T>> {
    const { scope, ledgerKey, intent } = this.resolveKey(key);
    return this.execute(scope, ledgerKey, intent, null, effect, { ...options, conflict: 'none', ack: false });
  }

  /** "Was this already done?" — safe to expose to a model as a read-only tool. */
  async check(key: string | KeyParts): Promise<CheckResult> {
    const { scope, ledgerKey } = this.resolveKey(key);
    const state = await this.store.read(scope);
    const entry = state?.effects[ledgerKey] ?? null;
    if (!entry) return { done: false, status: 'none', entry: null };
    const status = logic.effectiveStatus(entry, this.now(), this.policy);
    return { done: status === 'committed', status, entry };
  }

  /** Every effect recorded on a scope, oldest first. */
  async history(scope: string): Promise<EffectRecord[]> {
    const state = await this.store.read(scope);
    if (!state) return [];
    const now = this.now();
    return Object.values(state.effects)
      .map((e) => ({ ...e, status: logic.effectiveStatus(e, now, this.policy) }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Record what an operator or reconciler found out about an ambiguous effect. */
  async resolve(
    key: string | KeyParts,
    verdict: { outcome: 'committed'; result?: Json } | { outcome: 'not_applied' },
  ): Promise<EffectRecord | null> {
    const { scope, ledgerKey } = this.resolveKey(key);
    const result = 'result' in verdict ? verdict.result : undefined;
    const now = this.now();
    const entry = await this.store.transact(scope, (s) =>
      logic.resolve(s, { key: ledgerKey, outcome: verdict.outcome, result, now }, this.policy),
    );
    if (entry) this.emit({ type: 'reconciled', scope, key: ledgerKey, outcome: verdict.outcome });
    return entry;
  }

  /**
   * Start (or, with the same `runId`, resume) a unit of work on a scope. The run gets a
   * fencing token; its writes are refused once a newer run owns the scope.
   */
  async begin(scope: string, options: BeginOptions = {}): Promise<Run> {
    assertScope(scope);
    const runId = options.runId ?? randomUUID();
    const leaseTtlMs = options.leaseTtlMs ?? this.leaseTtlMs;
    const now = this.now();
    const outcome = await this.store.transact(scope, (s) =>
      logic.begin(
        s,
        {
          runId,
          mode: options.mode ?? 'supersede',
          leaseTtlMs,
          now,
          ...(options.contextAt !== undefined ? { contextAt: options.contextAt } : {}),
        },
        this.policy,
      ),
    );
    return new Run(this, scope, runId, leaseTtlMs, outcome);
  }

  /** Cancel a run: its future writes are refused with `run_cancelled`. */
  async cancel(scope: string, runId: string): Promise<boolean> {
    const now = this.now();
    const r = await this.store.transact(scope, (s) =>
      logic.endRun(s, { runId, reason: 'cancelled', now }, this.policy),
    );
    return r !== null;
  }

  /** @internal */
  async renewRun(scope: string, runId: string, token: number, leaseTtlMs: number): Promise<boolean> {
    const now = this.now();
    const r = await this.store.transact(scope, (s) =>
      logic.renew(s, { runId, token, leaseTtlMs, now }, this.policy),
    );
    return r.ok;
  }

  /** @internal */
  async endRun(scope: string, runId: string, token: number, reason: RunEndReason): Promise<void> {
    const now = this.now();
    await this.store.transact(scope, (s) => logic.endRun(s, { runId, token, reason, now }, this.policy));
  }

  /** @internal */
  resolveKey(key: string | KeyParts): { scope: string; ledgerKey: string; intent: string } {
    if (typeof key === 'string') {
      assertScope(key);
      return { scope: key, ledgerKey: key, intent: 'once' };
    }
    assertScope(key.scope);
    return { scope: key.scope, ledgerKey: effectKey(key.intent, key.payload), intent: key.intent };
  }

  /** @internal */
  async execute<T>(
    scope: string,
    key: string,
    intent: string,
    run: { runId: string; token: number; leaseTtlMs: number } | null,
    effect: Effect<T>,
    options: RunOnceOptions,
  ): Promise<OnceResult<T>> {
    const runId = run?.runId ?? null;
    const token = run?.token ?? null;
    const classify = options.classifyError ?? this.classify;
    const reconcile = options.reconcile ?? this.reconciler;
    const waitUntil = options.wait ? this.now() + options.wait.timeoutMs : 0;
    let reconciledOnce = false;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const attemptId = randomUUID();
      const now = this.now();
      const claimed: ClaimOutcome = await this.store.transact(scope, (s) =>
        logic.claim(
          s,
          scope,
          {
            key,
            intent,
            summary: options.summary ?? null,
            runId,
            token,
            attemptId,
            conflict: options.conflict ?? 'any',
            ack: options.ack ?? true,
            leaseTtlMs: run?.leaseTtlMs ?? this.leaseTtlMs,
            now,
          },
          this.policy,
        ),
      );

      switch (claimed.kind) {
        case 'replay':
          this.emit({ type: 'replayed', scope, key });
          return { status: 'replayed', ok: true, value: claimed.entry.result as T, key, entry: claimed.entry };

        case 'refused':
          this.emit({ type: 'refused', scope, key, reason: claimed.reason, runId });
          return {
            status: 'refused',
            ok: false,
            key,
            reason: claimed.reason,
            ...(claimed.conflicts ? { conflicts: claimed.conflicts } : {}),
            ...(claimed.entry ? { entry: claimed.entry } : {}),
          };

        case 'in_flight': {
          if (options.wait && this.now() < waitUntil) {
            await this.waitForSettle(scope, key, waitUntil, options.wait.intervalMs ?? 100);
            continue;
          }
          this.emit({ type: 'in_flight', scope, key });
          return { status: 'in_flight', ok: false, key, entry: claimed.entry };
        }

        case 'ambiguous': {
          if (reconcile && !reconciledOnce) {
            reconciledOnce = true;
            let verdict: ReconcileVerdict;
            try {
              verdict = await reconcile(claimed.entry);
            } catch {
              verdict = { outcome: 'unknown' };
            }
            if (verdict.outcome !== 'unknown') {
              const at = this.now();
              const resolved = await this.store.transact(scope, (s) =>
                logic.resolve(
                  s,
                  {
                    key,
                    outcome: verdict.outcome as 'committed' | 'not_applied',
                    result: verdict.outcome === 'committed' ? verdict.result : undefined,
                    attemptId: claimed.entry.attemptId,
                    now: at,
                  },
                  this.policy,
                ),
              );
              if (resolved) this.emit({ type: 'reconciled', scope, key, outcome: verdict.outcome });
              continue;
            }
          }
          this.emit({ type: 'ambiguous', scope, key });
          return { status: 'ambiguous', ok: false, key, entry: claimed.entry };
        }

        case 'acquired':
          return this.runAcquired(scope, key, claimed.entry, effect, classify);
      }
    }
    const entry = (await this.store.read(scope))?.effects[key];
    if (entry && entry.status === 'committed') {
      return { status: 'replayed', ok: true, value: entry.result as T, key, entry };
    }
    if (entry) {
      this.emit({ type: 'in_flight', scope, key });
      return { status: 'in_flight', ok: false, key, entry };
    }
    throw new Error('replyonce: could not claim key after several rounds');
  }

  private async runAcquired<T>(
    scope: string,
    key: string,
    entry: EffectRecord,
    effect: Effect<T>,
    classify: (err: unknown) => ErrorClass,
  ): Promise<OnceResult<T>> {
    const { attempt, attemptId, runId } = entry;
    this.emit({ type: 'claimed', scope, key, attempt, runId });
    const remaining = Math.max(1, entry.claimedAt + this.policy.pendingTtlMs - this.now());
    const ctx: EffectContext = {
      key,
      scope,
      intent: entry.intent,
      attempt,
      idempotencyKey: providerIdempotencyKey(scope, key),
      fencingToken: entry.token,
      signal: AbortSignal.timeout(remaining),
    };

    let value: T;
    try {
      value = await effect(ctx);
    } catch (error) {
      const cls = safeClassify(classify, error);
      const outcome = cls === 'not_applied' ? 'failed' : 'ambiguous';
      await this.settleWithRetry(scope, {
        key,
        attemptId,
        outcome,
        error: describeError(error),
        now: 0,
      }).catch(() => undefined);
      if (outcome === 'failed') {
        this.emit({ type: 'failed', scope, key, attempt, error });
        return {
          status: 'failed',
          ok: false,
          key,
          attempt,
          error,
          retryable: attempt < this.policy.maxAttempts,
        };
      }
      this.emit({ type: 'ambiguous', scope, key, error });
      const current = (await this.store.read(scope).catch(() => null))?.effects[key] ?? entry;
      return { status: 'ambiguous', ok: false, key, entry: current, error };
    }

    let stored: Json | undefined;
    try {
      stored = value === undefined ? null : (JSON.parse(JSON.stringify(value)) as Json);
    } catch {
      stored = null;
      this.emit({ type: 'unserializable_result', scope, key });
    }
    try {
      const settled = await this.settleWithRetry(scope, {
        key,
        attemptId,
        outcome: 'committed',
        result: stored,
        now: 0,
      });
      this.emit({ type: 'committed', scope, key, attempt, runId });
      if (settled.kind === 'stale' || settled.wasAbandoned) {
        this.emit({ type: 'late_settle', scope, key, attempt });
        return { status: 'executed', ok: true, value, key, attempt, lateSettle: true };
      }
    } catch {
      // The effect happened but the ledger could not record it. The claim stays pending and
      // later reads treat it as ambiguous, which fails safe.
      this.emit({ type: 'late_settle', scope, key, attempt });
      return { status: 'executed', ok: true, value, key, attempt, lateSettle: true };
    }
    return { status: 'executed', ok: true, value, key, attempt };
  }

  private async settleWithRetry(scope: string, input: logic.SettleInput): Promise<logic.SettleOutcome> {
    let lastError: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        const now = this.now();
        return await this.store.transact(scope, (s) => logic.settle(s, { ...input, now }, this.policy));
      } catch (err) {
        lastError = err;
        await this.sleep(25 * 4 ** i);
      }
    }
    throw lastError;
  }

  private async waitForSettle(scope: string, key: string, until: number, intervalMs: number): Promise<void> {
    while (this.now() < until) {
      await this.sleep(Math.min(intervalMs, Math.max(1, until - this.now())));
      const e = (await this.store.read(scope))?.effects[key];
      if (!e || logic.effectiveStatus(e, this.now(), this.policy) !== 'pending') return;
    }
  }
}

export type RunState = BeginOutcome['state'];

/** A unit of agent work on one scope, holding a fencing token. */
export class Run {
  readonly scope: string;
  readonly runId: string;
  /** `new`, `resumed` (same runId seen before), `superseded`, `ended`, or `busy` (exclusive mode). */
  readonly state: RunState;
  /** Monotonic per scope. `null` when the run could not start (`busy`). */
  readonly fencingToken: number | null;
  /** Effects this runId already claimed before (non-empty on redelivery). */
  readonly priorEffects: EffectRecord[];
  readonly busyHolder: { runId: string; token: number; leaseExpiresAt: number } | null;
  private readonly ro: ReplyOnce;
  private readonly leaseTtlMs: number;

  constructor(ro: ReplyOnce, scope: string, runId: string, leaseTtlMs: number, outcome: BeginOutcome) {
    this.ro = ro;
    this.scope = scope;
    this.runId = runId;
    this.leaseTtlMs = leaseTtlMs;
    this.state = outcome.state;
    if (outcome.state === 'busy') {
      this.fencingToken = null;
      this.priorEffects = [];
      this.busyHolder = outcome.holder;
    } else {
      this.fencingToken = (outcome.run as RunRecord).token;
      this.priorEffects = outcome.priorEffects;
      this.busyHolder = null;
    }
  }

  /** `true` when this run may write: it is new or resumed, not superseded, ended or busy. */
  get canWrite(): boolean {
    return this.state === 'new' || this.state === 'resumed';
  }

  /**
   * `true` when a previous delivery of this run already claimed a write that may have
   * reached the outside world (pending, committed or ambiguous).
   */
  get alreadyWrote(): boolean {
    return this.priorEffects.some((e) => e.status !== 'failed');
  }

  /** Run `effect` at most once per (scope, intent, payload), fenced to this run. */
  once<T>(intent: string, payload: unknown, effect: Effect<T>, options: RunOnceOptions = {}): Promise<OnceResult<T>> {
    const key = effectKey(intent, payload);
    if (this.fencingToken === null) {
      return Promise.resolve({ status: 'refused', ok: false, key, reason: 'busy' });
    }
    const self = { runId: this.runId, token: this.fencingToken, leaseTtlMs: this.leaseTtlMs };
    return this.ro.execute(this.scope, key, intent, self, effect, options);
  }

  check(intent: string, payload?: unknown): Promise<CheckResult> {
    return this.ro.check({ scope: this.scope, intent, payload });
  }

  history(): Promise<EffectRecord[]> {
    return this.ro.history(this.scope);
  }

  /**
   * Renew the lease. `false` means stop: the run was superseded (by a newer run or a later
   * delivery of this one), cancelled or ended.
   */
  heartbeat(): Promise<boolean> {
    if (this.fencingToken === null) return Promise.resolve(false);
    return this.ro.renewRun(this.scope, this.runId, this.fencingToken, this.leaseTtlMs);
  }

  /** Mark the run finished. A no-op if a later delivery of the same run has taken over. */
  end(reason: RunEndReason = 'completed'): Promise<void> {
    if (this.fencingToken === null) return Promise.resolve();
    return this.ro.endRun(this.scope, this.runId, this.fencingToken, reason);
  }
}

export function createReplyOnce(options: ReplyOnceOptions): ReplyOnce {
  return new ReplyOnce(options);
}

/** Return the value of a successful result, or throw a `ReplyOnceError` describing why not. */
export function unwrap<T>(result: OnceResult<T>): T {
  if (result.ok) return result.value;
  throw new ReplyOnceError(result);
}

export class ReplyOnceError extends Error {
  readonly result: Exclude<OnceResult<unknown>, { ok: true }>;
  constructor(result: Exclude<OnceResult<unknown>, { ok: true }>) {
    const detail = result.status === 'refused' ? `${result.status}: ${result.reason}` : result.status;
    super(`replyonce: effect ${result.key} not executed (${detail})`);
    this.name = 'ReplyOnceError';
    this.result = result;
  }
}

function assertScope(scope: string): void {
  if (typeof scope !== 'string' || scope.length === 0 || scope.length > 512) {
    throw new TypeError('replyonce: scope must be a non-empty string of at most 512 characters');
  }
}

function safeClassify(classify: (err: unknown) => ErrorClass, err: unknown): ErrorClass {
  try {
    return classify(err) === 'not_applied' ? 'not_applied' : 'ambiguous';
  } catch {
    return 'ambiguous';
  }
}

function describeError(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
