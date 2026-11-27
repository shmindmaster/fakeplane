import { expect, it } from 'vitest';
import { NotApplied, ReplyOnceError, createReplyOnce, unwrap } from '../src/index.js';
import type { ReplyOnceEvent } from '../src/index.js';
import { counter, eachStore, fakeClock, sleep, uid, until } from './helpers.js';

eachStore('once', (makeStore) => {
  it('runs an effect once and replays its result afterwards', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const c = counter();
    const key = { scope: uid(), intent: 'refund', payload: { order: 'o-1', cents: 500 } };
    const first = await ro.once(key, () => {
      c.hit('refund');
      return { refundId: 're_1' };
    });
    const second = await ro.once(key, () => {
      c.hit('refund');
      return { refundId: 're_2' };
    });
    expect(first).toMatchObject({ status: 'executed', ok: true, value: { refundId: 're_1' }, attempt: 1 });
    expect(second).toMatchObject({ status: 'replayed', ok: true, value: { refundId: 're_1' } });
    expect(c.count('refund')).toBe(1);
  });

  it('treats a string key as its own scope', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const key = uid('evt');
    let n = 0;
    await ro.once(key, () => ++n);
    const again = await ro.once(key, () => ++n);
    expect(again.status).toBe('replayed');
    expect(n).toBe(1);
  });

  it('passes a stable idempotency key and no fencing token outside a run', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const seen: string[] = [];
    const key = { scope: uid(), intent: 'charge', payload: { invoice: 'i-1' } };
    await ro.once(key, (ctx) => {
      seen.push(ctx.idempotencyKey);
      expect(ctx.fencingToken).toBeNull();
      expect(ctx.attempt).toBe(1);
      throw new NotApplied('card declined before charge');
    });
    await ro.once(key, (ctx) => {
      seen.push(ctx.idempotencyKey);
      expect(ctx.attempt).toBe(2);
    });
    expect(seen[0]).toBe(seen[1]);
  });

  it('retries only after a NotApplied failure, up to maxAttempts', async () => {
    const ro = createReplyOnce({ store: await makeStore(), maxAttempts: 2 });
    const key = { scope: uid(), intent: 'ticket', payload: { m: 1 } };
    const r1 = await ro.once(key, () => {
      throw new NotApplied('400 validation');
    });
    expect(r1).toMatchObject({ status: 'failed', retryable: true, attempt: 1 });
    const r2 = await ro.once(key, () => {
      throw new NotApplied('400 validation');
    });
    expect(r2).toMatchObject({ status: 'failed', retryable: false, attempt: 2 });
    const r3 = await ro.once(key, () => 'never');
    expect(r3).toMatchObject({ status: 'refused', reason: 'exhausted' });
  });

  it('never retries an ambiguous outcome blindly', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const c = counter();
    const key = { scope: uid(), intent: 'send', payload: { m: 1 } };
    const r1 = await ro.once(key, () => {
      c.hit('send');
      throw new Error('ETIMEDOUT');
    });
    expect(r1.status).toBe('ambiguous');
    const r2 = await ro.once(key, () => c.hit('send'));
    expect(r2.status).toBe('ambiguous');
    expect(c.count('send')).toBe(1);
    expect((await ro.check(key)).status).toBe('ambiguous');
  });

  it('honours a custom error classifier', async () => {
    const ro = createReplyOnce({
      store: await makeStore(),
      classifyError: (err) => ((err as { status?: number }).status === 400 ? 'not_applied' : 'ambiguous'),
    });
    const key = { scope: uid(), intent: 'send', payload: 1 };
    const r = await ro.once(key, () => {
      throw Object.assign(new Error('bad request'), { status: 400 });
    });
    expect(r).toMatchObject({ status: 'failed', retryable: true });
  });

  it('reconciles an ambiguous effect: committed means replay, not_applied means retry', async () => {
    const store = await makeStore();
    const sent = new Set<string>();
    const ro = createReplyOnce({
      store,
      reconcile: async (entry) =>
        sent.has(entry.key) ? { outcome: 'committed', result: { found: true } } : { outcome: 'not_applied' },
    });
    const landed = { scope: uid(), intent: 'reply', payload: { inReplyTo: 'm1' } };
    await ro.once(landed, (ctx) => {
      sent.add(ctx.key);
      throw new Error('socket hang up');
    });
    const r1 = await ro.once(landed, () => 'should not run');
    expect(r1).toMatchObject({ status: 'replayed', value: { found: true } });

    const lost = { scope: uid(), intent: 'reply', payload: { inReplyTo: 'm2' } };
    await ro.once(lost, () => {
      throw new Error('ECONNRESET before write');
    });
    const r2 = await ro.once(lost, () => 'sent now');
    expect(r2).toMatchObject({ status: 'executed', value: 'sent now', attempt: 2 });
  });

  it('keeps an ambiguous effect ambiguous when the reconciler cannot tell', async () => {
    const ro = createReplyOnce({ store: await makeStore(), reconcile: async () => ({ outcome: 'unknown' }) });
    const key = { scope: uid(), intent: 'reply', payload: 1 };
    await ro.once(key, () => {
      throw new Error('timeout');
    });
    expect((await ro.once(key, () => 1)).status).toBe('ambiguous');
  });

  it('lets an operator resolve an ambiguous effect', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const key = { scope: uid(), intent: 'refund', payload: { order: 'o-9' } };
    await ro.once(key, () => {
      throw new Error('timeout');
    });
    const resolved = await ro.resolve(key, { outcome: 'committed', result: 'checked by hand' });
    expect(resolved?.status).toBe('committed');
    expect(await ro.once(key, () => 'x')).toMatchObject({ status: 'replayed', value: 'checked by hand' });
    expect(await ro.resolve(key, { outcome: 'not_applied' })).toBeNull();
  });

  it('reports a concurrent duplicate as in_flight, or waits for it', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const key = { scope: uid(), intent: 'reply', payload: 1 };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const first = ro.once(key, async () => {
      started = true;
      await gate;
      return 'done';
    });
    await until(() => started);
    expect((await ro.once(key, () => 'dup')).status).toBe('in_flight');
    const waiting = ro.once(key, () => 'dup', { wait: { timeoutMs: 2_000, intervalMs: 5 } });
    await sleep(20);
    release();
    expect(await first).toMatchObject({ status: 'executed', value: 'done' });
    expect(await waiting).toMatchObject({ status: 'replayed', value: 'done' });
  });

  it('treats a claim that was never settled as ambiguous after pendingTtlMs', async () => {
    const clock = fakeClock();
    const store = await makeStore();
    const ro = createReplyOnce({ store, clock: clock.now, pendingTtlMs: 1_000 });
    const key = { scope: uid(), intent: 'reply', payload: 1 };
    let started = false;
    void ro.once(key, () => {
      started = true;
      return new Promise(() => {}); // the worker "crashes" mid-effect
    });
    await until(() => started);
    expect((await ro.once(key, () => 1)).status).toBe('in_flight');
    clock.advance(1_000);
    expect((await ro.check(key)).status).toBe('ambiguous');
    const r = await ro.once(key, () => 1);
    expect(r.status).toBe('ambiguous');
    expect((await ro.history(key.scope))[0]?.error).toMatch(/abandoned/);
  });

  it('flags a late settle when the claim was already given up on', async () => {
    const clock = fakeClock();
    const ro = createReplyOnce({ store: await makeStore(), clock: clock.now, pendingTtlMs: 1_000 });
    const key = { scope: uid(), intent: 'reply', payload: 1 };
    const r = await ro.once(key, async () => {
      clock.advance(5_000);
      return 'slow';
    });
    expect(r).toMatchObject({ status: 'executed', lateSettle: true });
    expect((await ro.check(key)).status).toBe('committed');
  });

  it('accepts a late committed settle over a not_applied verdict for the same attempt', async () => {
    const clock = fakeClock();
    const ro = createReplyOnce({ store: await makeStore(), clock: clock.now, pendingTtlMs: 1_000 });
    const key = { scope: uid(), intent: 'reply', payload: 1 };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const slow = ro.once(key, async () => {
      started = true;
      await gate;
      return 'landed';
    });
    await until(() => started);
    clock.advance(2_000);
    await ro.resolve(key, { outcome: 'not_applied' });
    release();
    expect(await slow).toMatchObject({ status: 'executed', lateSettle: true });
    expect((await ro.check(key)).status).toBe('committed');
  });

  it('check() answers "was this already done?"', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const key = { scope: uid(), intent: 'create_ticket', payload: { email: 'msg-1' } };
    expect(await ro.check(key)).toMatchObject({ done: false, status: 'none', entry: null });
    await ro.once(key, () => 'T-1', { summary: 'Ticket for msg-1' });
    expect(await ro.check(key)).toMatchObject({ done: true, status: 'committed' });
    const h = await ro.history(key.scope);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ intent: 'create_ticket', summary: 'Ticket for msg-1', result: 'T-1' });
  });

  it('stores unserializable results as null and still commits', async () => {
    const events: ReplyOnceEvent[] = [];
    const ro = createReplyOnce({ store: await makeStore(), onEvent: (e) => events.push(e) });
    const key = { scope: uid(), intent: 'x', payload: 1 };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect((await ro.once(key, () => circular)).status).toBe('executed');
    expect(await ro.once(key, () => 1)).toMatchObject({ status: 'replayed', value: null });
    expect(events.map((e) => e.type)).toContain('unserializable_result');
  });

  it('emits events and survives a throwing observer', async () => {
    const types: string[] = [];
    const ro = createReplyOnce({
      store: await makeStore(),
      onEvent: (e) => {
        types.push(e.type);
        throw new Error('observer bug');
      },
    });
    const key = { scope: uid(), intent: 'x', payload: 1 };
    await ro.once(key, () => 1);
    await ro.once(key, () => 1);
    expect(types).toEqual(['claimed', 'committed', 'replayed']);
  });

  it('unwrap returns the value or throws a ReplyOnceError', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const key = { scope: uid(), intent: 'x', payload: 1 };
    expect(unwrap(await ro.once(key, () => 42))).toBe(42);
    const bad = await ro.once({ ...key, payload: 2 }, () => {
      throw new Error('timeout');
    });
    expect(() => unwrap(bad)).toThrow(ReplyOnceError);
  });

  it('forgets settled effects after retentionMs', async () => {
    const clock = fakeClock();
    const ro = createReplyOnce({ store: await makeStore(), clock: clock.now, retentionMs: 10_000 });
    const key = { scope: uid(), intent: 'x', payload: 1 };
    await ro.once(key, () => 1);
    clock.advance(10_001);
    expect((await ro.once(key, () => 2)).status).toBe('executed');
  });
});

it('rejects invalid configuration', () => {
  expect(() => createReplyOnce({} as never)).toThrow(/store/);
  expect(() => createReplyOnce({ store: { transact: async () => null, read: async () => null } as never, maxAttempts: 0 })).toThrow(
    RangeError,
  );
});
