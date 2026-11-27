import type {
  ConflictInfo,
  EffectRecord,
  Json,
  RefusalReason,
  RunEndReason,
  RunMode,
  RunRecord,
  ScopeState,
  TransactResult,
} from './types.js';

/**
 * The replyonce state machine. Every function here is pure: it takes a scope's state and
 * returns the next state plus a decision. Stores only make each call atomic.
 */

export interface Policy {
  pendingTtlMs: number;
  maxAttempts: number;
  retentionMs: number;
}

export type ConflictMode = 'any' | 'same-intent' | 'none';

const SUMMARY_MAX = 2000;

function emptyState(): ScopeState {
  return { v: 1, seq: 0, tokenSeq: 0, runs: {}, effects: {} };
}

function load(state: ScopeState | null, now: number, policy: Policy): ScopeState {
  const s = state ? (structuredClone(state) as ScopeState) : emptyState();
  if (s.v !== 1) throw new Error(`replyonce: unsupported state version ${String(s.v)}`);
  const horizon = now - policy.retentionMs;
  for (const [k, e] of Object.entries(s.effects)) {
    if ((e.status === 'committed' || e.status === 'failed') && (e.settledAt ?? e.claimedAt) < horizon) {
      delete s.effects[k];
    }
  }
  for (const [id, r] of Object.entries(s.runs)) {
    if ((r.endedAt ?? r.leaseExpiresAt) < horizon) delete s.runs[id];
  }
  return s;
}

/** Advance the scope's logical clock for a change being made now. */
function tick(s: ScopeState): number {
  s.seq += 1;
  return s.seq;
}

function isAbandoned(e: EffectRecord, now: number, policy: Policy): boolean {
  return e.status === 'pending' && now - e.claimedAt >= policy.pendingTtlMs;
}

/** The status a reader should act on: a pending claim past its TTL is treated as ambiguous. */
export function effectiveStatus(e: EffectRecord, now: number, policy: Policy): EffectRecord['status'] {
  return isAbandoned(e, now, policy) ? 'ambiguous' : e.status;
}

function isLive(r: RunRecord, now: number): boolean {
  return r.endedAt === null && r.leaseExpiresAt > now;
}

/**
 * Is `a` newer than `b`? Exclusive leases order by token; otherwise by context recency. Never
 * by token there: a redelivery bumps an old run's token. Equal context times order by when
 * the run first began only if neither run gave a `contextAt`, because then each read its
 * context as it began. Otherwise neither is newer: begin order says nothing about whose
 * context is fresher, and fencing out the wrong one would leave its message unanswered.
 * Both may then write; conflict checks keep them from answering the same thing twice.
 */
function isNewer(a: RunRecord, b: RunRecord): boolean {
  if (a.mode === 'exclusive' && b.mode === 'exclusive') return a.token > b.token;
  if (a.orderAt !== b.orderAt) return a.orderAt > b.orderAt;
  if (a.baseContextAt !== null || b.baseContextAt !== null) return false;
  return a.baseSeq > b.baseSeq;
}

/**
 * A newer run owns the scope if it is live, or if it already wrote (it may have answered).
 * A newer run that ended without writing, or was cancelled, does not.
 */
function supersedingRun(s: ScopeState, run: RunRecord, now: number): RunRecord | null {
  let best: RunRecord | null = null;
  for (const r of Object.values(s.runs)) {
    if (r.runId === run.runId || r.endReason === 'cancelled' || !isNewer(r, run)) continue;
    if (r.wrote || isLive(r, now)) {
      if (!best || isNewer(r, best)) best = r;
    }
  }
  return best;
}

function markSeen(run: RunRecord, seq: number, now: number): void {
  run.seenSeq = Math.max(run.seenSeq, seq);
  run.seenAt = Math.max(run.seenAt, now);
  run.contextAt = null;
}

// ---------------------------------------------------------------- begin

export interface BeginInput {
  runId: string;
  mode: RunMode;
  leaseTtlMs: number;
  now: number;
  /** When the run's view of the scope was read. Writes that landed after it are conflicts. */
  contextAt?: number;
}

export type BeginOutcome =
  | { state: 'new' | 'resumed' | 'superseded' | 'ended'; run: RunRecord; priorEffects: EffectRecord[] }
  | { state: 'busy'; holder: { runId: string; token: number; leaseExpiresAt: number } };

export function begin(
  state: ScopeState | null,
  input: BeginInput,
  policy: Policy,
): TransactResult<BeginOutcome> {
  const { now } = input;
  const s = load(state, now, policy);
  const existing = s.runs[input.runId];
  if (existing) {
    const priorEffects = Object.values(s.effects).filter((e) => e.runId === input.runId);
    if (existing.endedAt !== null) {
      return { next: null, result: { state: 'ended', run: existing, priorEffects } };
    }
    existing.leaseExpiresAt = Math.max(existing.leaseExpiresAt, now + input.leaseTtlMs);
    tick(s);
    // A redelivery takes the run over; any earlier delivery still executing is fenced out.
    s.tokenSeq += 1;
    existing.token = s.tokenSeq;
    // It acts on the run's original context, so it has not seen what earlier deliveries saw,
    // unless it says it re-read the scope.
    existing.seenSeq = existing.baseSeq;
    existing.seenAt = existing.baseContextAt ?? existing.startedAt;
    existing.contextAt = existing.baseContextAt;
    if (input.contextAt !== undefined && input.contextAt > existing.seenAt) {
      const fresh = Math.min(input.contextAt, now);
      for (const e of Object.values(s.effects)) {
        if (e.settleSeq !== null && e.settledAt !== null && e.settledAt < fresh) {
          existing.seenSeq = Math.max(existing.seenSeq, e.settleSeq);
        }
      }
      existing.seenAt = fresh;
      existing.contextAt = fresh;
    }
    const newer = supersedingRun(s, existing, now);
    return { next: s, result: { state: newer ? 'superseded' : 'resumed', run: existing, priorEffects } };
  }
  if (input.mode === 'exclusive') {
    let holder: RunRecord | undefined;
    for (const r of Object.values(s.runs)) {
      if (isLive(r, now) && (!holder || r.token > holder.token)) holder = r;
    }
    if (holder) {
      return {
        next: null,
        result: {
          state: 'busy',
          holder: { runId: holder.runId, token: holder.token, leaseExpiresAt: holder.leaseExpiresAt },
        },
      };
    }
  }
  const seq = tick(s);
  s.tokenSeq += 1;
  const contextAt = input.contextAt === undefined ? null : Math.min(input.contextAt, now);
  const run: RunRecord = {
    runId: input.runId,
    token: s.tokenSeq,
    mode: input.mode,
    startedAt: now,
    orderAt: input.mode === 'exclusive' ? now : (contextAt ?? now),
    leaseExpiresAt: now + input.leaseTtlMs,
    seenSeq: seq,
    seenAt: contextAt ?? now,
    contextAt,
    baseSeq: seq,
    baseContextAt: contextAt,
    wrote: false,
    endedAt: null,
    endReason: null,
  };
  s.runs[input.runId] = run;
  const newer = supersedingRun(s, run, now);
  return { next: s, result: { state: newer ? 'superseded' : 'new', run, priorEffects: [] } };
}

// ---------------------------------------------------------------- heartbeat / end

export type RenewOutcome =
  | { ok: true; run: RunRecord }
  | { ok: false; reason: 'unknown_run' | 'run_ended' | 'run_cancelled' | 'superseded' };

export function renew(
  state: ScopeState | null,
  input: { runId: string; token: number; leaseTtlMs: number; now: number },
  policy: Policy,
): TransactResult<RenewOutcome> {
  const s = load(state, input.now, policy);
  const r = s.runs[input.runId];
  if (!r) return { next: null, result: { ok: false, reason: 'unknown_run' } };
  if (r.token !== input.token) return { next: null, result: { ok: false, reason: 'superseded' } };
  if (r.endReason === 'cancelled') return { next: null, result: { ok: false, reason: 'run_cancelled' } };
  if (r.endedAt !== null) return { next: null, result: { ok: false, reason: 'run_ended' } };
  if (supersedingRun(s, r, input.now)) return { next: null, result: { ok: false, reason: 'superseded' } };
  r.leaseExpiresAt = Math.max(r.leaseExpiresAt, input.now + input.leaseTtlMs);
  tick(s);
  return { next: s, result: { ok: true, run: r } };
}

export function endRun(
  state: ScopeState | null,
  input: { runId: string; reason: RunEndReason; now: number; /** Ignore if a later delivery holds the run. */ token?: number },
  policy: Policy,
): TransactResult<RunRecord | null> {
  const s = load(state, input.now, policy);
  const r = s.runs[input.runId];
  if (!r) return { next: null, result: null };
  if (input.token !== undefined && r.token !== input.token) return { next: null, result: null };
  if (r.endedAt !== null && !(input.reason === 'cancelled' && r.endReason !== 'cancelled')) {
    return { next: null, result: r };
  }
  r.endedAt = r.endedAt ?? input.now;
  r.endReason = input.reason;
  tick(s);
  return { next: s, result: r };
}

// ---------------------------------------------------------------- claim

export interface ClaimInput {
  key: string;
  intent: string;
  summary: string | null;
  runId: string | null;
  /** The claiming delivery's fencing token. A stale token is refused as superseded. */
  token: number | null;
  attemptId: string;
  conflict: ConflictMode;
  ack: boolean;
  leaseTtlMs: number;
  now: number;
}

export type ClaimOutcome =
  | { kind: 'acquired'; entry: EffectRecord }
  | { kind: 'replay'; entry: EffectRecord }
  | { kind: 'in_flight'; entry: EffectRecord }
  | { kind: 'ambiguous'; entry: EffectRecord }
  | { kind: 'refused'; reason: RefusalReason; conflicts?: ConflictInfo[]; entry?: EffectRecord };

/** Writes by others on the scope that `run` has not seen yet, or that may still land. */
function conflictsFor(
  s: ScopeState,
  run: RunRecord,
  key: string,
  intent: string,
  mode: ConflictMode,
  now: number,
  policy: Policy,
): ConflictInfo[] {
  if (mode === 'none') return [];
  const out: ConflictInfo[] = [];
  for (const e of Object.values(s.effects)) {
    if (e.key === key) continue;
    if (e.runId === run.runId) {
      // This delivery knows its own writes. An earlier delivery's writes matter only when
      // this one is about to do the same kind of thing differently (a reply worded anew).
      if (e.token === run.token || e.intent !== intent) continue;
    }
    if (mode === 'same-intent' && e.intent !== intent) continue;
    const abandoned = isAbandoned(e, now, policy);
    let conflict = false;
    if (e.status === 'pending' && !abandoned) {
      conflict = true;
    } else if (abandoned) {
      // It may have landed at any time up to when it became abandoned.
      conflict = e.claimedAt + policy.pendingTtlMs >= run.seenAt;
    } else if (e.status === 'committed' || e.status === 'ambiguous') {
      conflict =
        (e.settleSeq ?? 0) > run.seenSeq || (run.contextAt !== null && (e.settledAt ?? 0) >= run.contextAt);
    }
    if (conflict) {
      out.push({
        key: e.key,
        intent: e.intent,
        status: abandoned ? 'ambiguous' : e.status,
        runId: e.runId,
        summary: e.summary,
        at: e.settledAt ?? e.claimedAt,
      });
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, 10);
}

export function claim(
  state: ScopeState | null,
  scope: string,
  input: ClaimInput,
  policy: Policy,
): TransactResult<ClaimOutcome> {
  const { now } = input;
  const s = load(state, now, policy);
  const prior = s.effects[input.key];

  if (prior) {
    if (prior.status === 'committed') return { next: null, result: { kind: 'replay', entry: prior } };
    if (prior.status === 'pending') {
      if (!isAbandoned(prior, now, policy)) {
        return { next: null, result: { kind: 'in_flight', entry: prior } };
      }
      const seq = tick(s);
      prior.status = 'ambiguous';
      prior.settledAt = prior.claimedAt + policy.pendingTtlMs;
      prior.settleSeq = seq;
      prior.error = prior.error ?? 'abandoned: not settled within pendingTtlMs';
      return { next: s, result: { kind: 'ambiguous', entry: prior } };
    }
    if (prior.status === 'ambiguous') return { next: null, result: { kind: 'ambiguous', entry: prior } };
    if (prior.attempt >= policy.maxAttempts) {
      return { next: null, result: { kind: 'refused', reason: 'exhausted', entry: prior } };
    }
  }

  let run: RunRecord | undefined;
  if (input.runId !== null) {
    run = s.runs[input.runId];
    if (!run) return { next: null, result: { kind: 'refused', reason: 'unknown_run' } };
    if (run.endReason === 'cancelled') return { next: null, result: { kind: 'refused', reason: 'run_cancelled' } };
    if (run.endedAt !== null) return { next: null, result: { kind: 'refused', reason: 'run_ended' } };
    if ((input.token !== null && run.token !== input.token) || supersedingRun(s, run, now)) {
      return { next: null, result: { kind: 'refused', reason: 'superseded' } };
    }

    const conflicts = conflictsFor(s, run, input.key, input.intent, input.conflict, now, policy);
    if (conflicts.length > 0) {
      if (!input.ack) {
        return { next: null, result: { kind: 'refused', reason: 'conversation_changed', conflicts } };
      }
      markSeen(run, tick(s), now);
      return { next: s, result: { kind: 'refused', reason: 'conversation_changed', conflicts } };
    }
  }

  const seq = tick(s);
  const entry: EffectRecord = {
    key: input.key,
    scope,
    intent: input.intent,
    status: 'pending',
    attempt: (prior?.attempt ?? 0) + 1,
    attemptId: input.attemptId,
    runId: input.runId,
    token: run?.token ?? null,
    summary: input.summary === null ? null : input.summary.slice(0, SUMMARY_MAX),
    error: null,
    createdAt: prior?.createdAt ?? now,
    claimedAt: now,
    settledAt: null,
    claimSeq: seq,
    settleSeq: null,
  };
  s.effects[input.key] = entry;
  if (run) {
    // A claim does not mark anything seen: writes this check deliberately skipped (other
    // intents, or `none`) must still be reported to a later check that covers them.
    run.wrote = true;
    run.leaseExpiresAt = Math.max(run.leaseExpiresAt, now + input.leaseTtlMs);
  }
  return { next: s, result: { kind: 'acquired', entry } };
}

// ---------------------------------------------------------------- settle / resolve

export interface SettleInput {
  key: string;
  attemptId: string;
  outcome: 'committed' | 'failed' | 'ambiguous';
  result?: Json;
  error?: string | null;
  now: number;
}

export type SettleOutcome =
  | { kind: 'settled'; entry: EffectRecord; wasAbandoned: boolean }
  | { kind: 'stale'; entry: EffectRecord | null };

export function settle(
  state: ScopeState | null,
  input: SettleInput,
  policy: Policy,
): TransactResult<SettleOutcome> {
  const s = load(state, input.now, policy);
  const e = s.effects[input.key];
  // A late "committed" from the attempt a reconciler judged not applied is still the truth.
  const lateTruth = e?.status === 'failed' && input.outcome === 'committed';
  if (
    !e ||
    e.attemptId !== input.attemptId ||
    (e.status !== 'pending' && e.status !== 'ambiguous' && !lateTruth)
  ) {
    return { next: null, result: { kind: 'stale', entry: e ?? null } };
  }
  const wasAbandoned = e.status !== 'pending' || isAbandoned(e, input.now, policy);
  e.status = input.outcome;
  e.settledAt = input.now;
  e.settleSeq = tick(s);
  e.error = input.error ?? null;
  if (input.outcome === 'committed' && input.result !== undefined) e.result = input.result;
  return { next: s, result: { kind: 'settled', entry: e, wasAbandoned } };
}

export interface ResolveInput {
  key: string;
  outcome: 'committed' | 'not_applied';
  result?: Json;
  /** Only resolve if the ledger still holds this attempt. */
  attemptId?: string;
  now: number;
}

/** Resolve an ambiguous (or abandoned) effect after checking the outside world. */
export function resolve(
  state: ScopeState | null,
  input: ResolveInput,
  policy: Policy,
): TransactResult<EffectRecord | null> {
  const s = load(state, input.now, policy);
  const e = s.effects[input.key];
  if (!e) return { next: null, result: null };
  if (input.attemptId !== undefined && e.attemptId !== input.attemptId) return { next: null, result: null };
  if (effectiveStatus(e, input.now, policy) !== 'ambiguous') return { next: null, result: null };
  e.settledAt = input.now;
  e.settleSeq = tick(s);
  if (input.outcome === 'committed') {
    e.status = 'committed';
    e.error = null;
    if (input.result !== undefined) e.result = input.result;
  } else {
    e.status = 'failed';
    e.error = 'reconciled: not applied';
  }
  return { next: s, result: e };
}
