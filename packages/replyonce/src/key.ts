import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted, `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new Set()));
}

function normalize(value: unknown, seen: Set<unknown>): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    if (typeof value === 'function' || typeof value === 'symbol') return null;
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) throw new TypeError('replyonce: cannot hash a circular payload');
  seen.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((v) => normalize(v, seen));
  } else {
    const obj: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      obj[k] = normalize(v, seen);
    }
    out = obj;
  }
  seen.delete(value);
  return out;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashPayload(payload: unknown): string {
  return sha256Hex(canonicalJson(payload)).slice(0, 32);
}

const SAFE_INTENT = /^[A-Za-z0-9_.:-]{1,100}$/;

/** Ledger key for an intent plus the business identity of the payload. */
export function effectKey(intent: string, payload: unknown): string {
  if (!SAFE_INTENT.test(intent)) {
    throw new TypeError(
      `replyonce: intent must match ${SAFE_INTENT} (got ${JSON.stringify(intent)})`,
    );
  }
  return payload === undefined ? intent : `${intent}:${hashPayload(payload)}`;
}

/** Stable idempotency key to hand to a provider (Stripe-style `Idempotency-Key`). */
export function providerIdempotencyKey(scope: string, key: string): string {
  return `ro_${sha256Hex(`${scope}\u0000${key}`).slice(0, 40)}`;
}
