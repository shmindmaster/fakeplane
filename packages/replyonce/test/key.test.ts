import { describe, expect, it } from 'vitest';
import { canonicalJson, effectKey, hashPayload, providerIdempotencyKey } from '../src/index.js';

describe('keys', () => {
  it('canonical JSON ignores key order and undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}',
    );
  });

  it('hashes equal payloads equally regardless of key order', () => {
    expect(hashPayload({ order: 'o-1', amount: 500 })).toBe(hashPayload({ amount: 500, order: 'o-1' }));
    expect(hashPayload({ order: 'o-1', amount: 500 })).not.toBe(hashPayload({ order: 'o-1', amount: 501 }));
  });

  it('normalises dates and bigints', () => {
    expect(canonicalJson({ at: new Date('2026-01-01T00:00:00Z'), n: 10n })).toBe(
      '{"at":"2026-01-01T00:00:00.000Z","n":"10"}',
    );
  });

  it('uses ECMAScript number formatting shared with the Python package', () => {
    // These exact strings are frozen as cross-language vectors in
    // python/tests/test_key.py. Changing them is a ledger-compatibility break.
    expect(canonicalJson({ n: 1e-7 })).toBe('{"n":1e-7}');
    expect(canonicalJson({ n: 1.5e-7 })).toBe('{"n":1.5e-7}');
    expect(canonicalJson({ n: 1e-6 })).toBe('{"n":0.000001}');
    expect(canonicalJson({ n: 1e-5 })).toBe('{"n":0.00001}');
    expect(canonicalJson({ n: 1e20 })).toBe('{"n":100000000000000000000}');
    expect(canonicalJson({ n: 1e21 })).toBe('{"n":1e+21}');
    expect(canonicalJson({ n: -1e21 })).toBe('{"n":-1e+21}');
    expect(canonicalJson({ n: 1.2345678901234567e-8 })).toBe('{"n":1.2345678901234567e-8}');
    expect(canonicalJson({ n: 2 ** 60 })).toBe('{"n":1152921504606847000}');
    expect(canonicalJson({ n: 1000000000000000100 })).toBe('{"n":1000000000000000100}');
  });

  it('rejects circular payloads', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => hashPayload(a)).toThrow(/circular/);
  });

  it('builds intent-prefixed keys and validates intents', () => {
    expect(effectKey('reply', undefined)).toBe('reply');
    expect(effectKey('reply', { inReplyTo: 'm1' })).toMatch(/^reply:[0-9a-f]{32}$/);
    expect(() => effectKey('has space', {})).toThrow(/intent/);
  });

  it('derives a stable provider idempotency key', () => {
    const k = providerIdempotencyKey('conv-1', 'refund:abc');
    expect(k).toBe(providerIdempotencyKey('conv-1', 'refund:abc'));
    expect(k).not.toBe(providerIdempotencyKey('conv-2', 'refund:abc'));
    expect(k).toMatch(/^ro_[0-9a-f]{40}$/);
  });
});
