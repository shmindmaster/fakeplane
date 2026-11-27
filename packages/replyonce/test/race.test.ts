import { expect, it } from 'vitest';
import { createReplyOnce } from '../src/index.js';
import { counter, eachStore, sleep, uid } from './helpers.js';

const jitter = (max: number) => sleep(Math.random() * max);

eachStore('races', (makeStore, storeName) => {
  const workers = storeName === 'memory' ? 64 : 32;

  it(`${workers} parallel workers on one key execute the effect exactly once`, async () => {
    const store = await makeStore();
    const c = counter();
    const key = { scope: uid(), intent: 'refund', payload: { order: 'o-1' } };
    const results = await Promise.all(
      Array.from({ length: workers }, async (_, i) => {
        const ro = createReplyOnce({ store });
        await jitter(5);
        return ro.once(
          key,
          async () => {
            c.hit('refund');
            await jitter(20);
            return `worker-${i}`;
          },
          { wait: { timeoutMs: 10_000, intervalMs: 5 } },
        );
      }),
    );
    expect(c.count('refund')).toBe(1);
    expect(results.filter((r) => r.status === 'executed')).toHaveLength(1);
    const winner = results.find((r) => r.status === 'executed')!;
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(winner.ok ? winner.value : undefined);
    }
  });

  it('a redelivery storm of one job sends each reply once, even with crashing workers', async () => {
    const store = await makeStore();
    const ro = createReplyOnce({ store, pendingTtlMs: 300 });
    const c = counter();
    const conv = uid();
    // The provider knows what it received; a reconciler can ask it.
    const reconcileRo = createReplyOnce({
      store,
      pendingTtlMs: 300,
      reconcile: async (e) => (c.count(e.key) > 0 ? { outcome: 'committed' } : { outcome: 'not_applied' }),
    });

    const crashes = (n: number) => n % 7 === 1;
    const deliver = async (n: number) => {
      const r = n % 3 === 0 ? reconcileRo : ro;
      await jitter(30);
      const run = await r.begin(conv, { runId: 'job-1' });
      if (!run.canWrite) return;
      for (const step of ['ack', 'answer', 'close'] as const) {
        const res = await run.once(
          step,
          { message: 'm1' },
          async (ctx) => {
            await jitter(5);
            c.hit(ctx.key);
            if (crashes(n)) await new Promise(() => {}); // the worker dies after the side effect
          },
          { wait: { timeoutMs: 2_000, intervalMs: 5 }, conflict: 'none' },
        );
        if (!res.ok) return;
      }
      await run.end();
    };
    const all = Array.from({ length: 30 }, (_, n) => deliver(n));
    await Promise.all(all.filter((_, n) => !crashes(n)));
    // A final clean delivery finishes whatever the crashed ones left behind.
    await sleep(350);
    const last = await reconcileRo.begin(conv, { runId: 'job-1' });
    if (last.canWrite) {
      for (const step of ['ack', 'answer', 'close'] as const) {
        await last.once(step, { message: 'm1' }, (ctx) => c.hit(ctx.key), { conflict: 'none' });
      }
    }
    expect(c.maxPerKey()).toBe(1);
  });

  it('webhook redelivery across many conversations: one effect per event', async () => {
    const store = await makeStore();
    const ro = createReplyOnce({ store });
    const c = counter();
    const events = Array.from({ length: 40 }, (_, i) => ({ scope: uid('ticket'), eventId: `evt-${i}` }));
    const deliveries = events.flatMap((e) => Array.from({ length: 4 }, () => e));
    deliveries.sort(() => Math.random() - 0.5);
    await Promise.all(
      deliveries.map(async (e) => {
        await jitter(10);
        await ro.once({ scope: e.scope, intent: 'webhook', payload: { eventId: e.eventId } }, async () => {
          await jitter(5);
          c.hit(e.eventId);
        });
      }),
    );
    // Deliveries that saw the first one in flight are retried by the provider later.
    for (const e of events) {
      await ro.once({ scope: e.scope, intent: 'webhook', payload: { eventId: e.eventId } }, () => c.hit(e.eventId), {
        wait: { timeoutMs: 2_000 },
      });
    }
    expect(c.maxPerKey()).toBe(1);
    expect(c.total).toBe(40);
  });

  it('concurrent runs on one conversation never answer a customer message twice', async () => {
    const store = await makeStore();
    // Snapshots often share a millisecond (Windows timers tick at about 15.6 ms). Such runs are
    // peers rather than ordered by begin, so the newest message's run is never fenced out.
    const ro = createReplyOnce({ store });
    const conv = uid();
    const inbound: string[] = [];
    const sent: string[][] = [];
    const answered = () => new Set(sent.flat());

    const runFor = async (snapshot: { inbound: string[]; answered: Set<string>; at: number }, id: string) => {
      await jitter(15);
      const run = await ro.begin(conv, { runId: id, contextAt: snapshot.at });
      if (!run.canWrite) return;
      let view = snapshot;
      for (let i = 0; i < 50; i++) {
        const todo = view.inbound.filter((m) => !view.answered.has(m));
        if (todo.length === 0) break;
        const res = await run.once('reply', { answers: todo }, async () => {
          await jitter(10);
          sent.push(todo);
        });
        if (res.ok) break;
        if (res.status === 'refused' && res.reason !== 'conversation_changed') break;
        await jitter(5);
        view = { inbound: [...inbound], answered: answered(), at: Date.now() };
      }
      await run.end();
    };

    const runs: Promise<void>[] = [];
    for (let m = 1; m <= 12; m++) {
      inbound.push(`m${m}`);
      const snapshot = { inbound: [...inbound], answered: answered(), at: Date.now() };
      runs.push(runFor(snapshot, `run-${m}`));
      if (m % 4 === 0) runs.push(runFor(snapshot, `run-${m}`)); // duplicate delivery
      await jitter(6);
    }
    await Promise.all(runs);

    const counts = new Map<string, number>();
    for (const reply of sent) for (const m of reply) counts.set(m, (counts.get(m) ?? 0) + 1);
    for (const m of inbound) expect(counts.get(m) ?? 0, `answers to ${m}`).toBeLessThanOrEqual(1);
    // The newest message is always answered: its run owns the conversation.
    expect(counts.get('m12')).toBe(1);
  });
});
