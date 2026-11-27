import { expect, it } from 'vitest';
import { createReplyOnce } from '../src/index.js';
import { eachStore, fakeClock, uid, until } from './helpers.js';

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

eachStore('runs and write fencing', (makeStore) => {
  it('lets the newest run own the conversation; older runs are refused', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const a = await ro.begin(conv);
    const b = await ro.begin(conv);
    expect(a.state).toBe('new');
    expect(b.fencingToken!).toBeGreaterThan(a.fencingToken!);
    expect(await a.once('reply', { to: 'm1' }, () => 'a')).toMatchObject({ status: 'refused', reason: 'superseded' });
    expect(await b.once('reply', { to: 'm1' }, () => 'b')).toMatchObject({ status: 'executed', value: 'b' });
    expect(await a.heartbeat()).toBe(false);
  });

  it('orders runs by context recency, not by when they started', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const t = Date.now();
    const newer = await ro.begin(conv, { contextAt: t });
    const older = await ro.begin(conv, { contextAt: t - 1_000 });
    expect(older.state).toBe('superseded');
    expect(older.canWrite).toBe(false);
    expect((await newer.once('reply', 1, () => 1)).status).toBe('executed');
  });

  it('runs whose contexts share a timestamp are not fenced by begin order, so every message is answered', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const sent: string[][] = [];
    // m1 and m2 arrive in the same millisecond, and m2's job happens to begin first.
    const t = Date.now() - 10;
    const forM2 = await ro.begin(conv, { runId: 'job-m2', contextAt: t });
    const forM1 = await ro.begin(conv, { runId: 'job-m1', contextAt: t });
    expect([forM2.state, forM1.state]).toEqual(['new', 'new']);
    expect((await forM1.once('reply', { answers: ['m1'] }, () => sent.push(['m1']))).status).toBe('executed');
    await forM1.end();
    // m2's run must not be refused as superseded by a run that never saw m2.
    expect(await forM2.once('reply', { answers: ['m1', 'm2'] }, () => sent.push(['m1', 'm2']))).toMatchObject({
      status: 'refused',
      reason: 'conversation_changed',
    });
    expect((await forM2.once('reply', { answers: ['m2'] }, () => sent.push(['m2']))).status).toBe('executed');
    expect(sent).toEqual([['m1'], ['m2']]);
  });

  it('without contextAt, the run that began later is newer even within one millisecond', async () => {
    const clock = fakeClock();
    const ro = createReplyOnce({ store: await makeStore(), clock: clock.now });
    const conv = uid();
    const a = await ro.begin(conv);
    const b = await ro.begin(conv);
    expect(await a.once('reply', 1, () => 'a')).toMatchObject({ status: 'refused', reason: 'superseded' });
    expect((await b.once('reply', 1, () => 'b')).status).toBe('executed');
  });

  it('a newer run that ended without writing does not silence the older one', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const a = await ro.begin(conv);
    const b = await ro.begin(conv);
    await b.end('failed');
    expect((await a.once('reply', 1, () => 'a')).status).toBe('executed');
  });

  it('a newer run that wrote keeps ownership after it ends', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const a = await ro.begin(conv);
    const b = await ro.begin(conv);
    await b.once('reply', 2, () => 'b');
    await b.end();
    expect(await a.once('reply', 1, () => 'a')).toMatchObject({ status: 'refused', reason: 'superseded' });
  });

  it('refuses a cancelled run, and a cancelled newer run does not supersede', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const a = await ro.begin(conv, { runId: 'run-a' });
    const b = await ro.begin(conv, { runId: 'run-b' });
    expect(await ro.cancel(conv, 'run-b')).toBe(true);
    expect(await b.once('reply', 1, () => 1)).toMatchObject({ status: 'refused', reason: 'run_cancelled' });
    expect((await a.once('reply', 1, () => 1)).status).toBe('executed');
    expect(await ro.cancel(conv, 'missing')).toBe(false);
  });

  it('refuses writes after a run ended and reports the end on redelivery', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const a = await ro.begin(conv, { runId: 'job-1' });
    await a.once('reply', 1, () => 1);
    await a.end();
    expect(await a.once('tag', 1, () => 1)).toMatchObject({ status: 'refused', reason: 'run_ended' });
    const again = await ro.begin(conv, { runId: 'job-1' });
    expect(again.state).toBe('ended');
    expect(again.alreadyWrote).toBe(true);
  });

  it('closes the duplicate-reply race: a write in flight when a newer run started', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const sent: string[] = [];
    const a = await ro.begin(conv);
    const g = gate();
    let started = false;
    const aReply = a.once(
      'reply',
      { answers: ['m1'] },
      async () => {
        started = true;
        await g.p;
        sent.push('A: answer to m1');
      },
      { summary: 'answer to m1' },
    );
    await until(() => started);
    // The customer writes again. The new run's context predates A's reply.
    const b = await ro.begin(conv);
    const r1 = await b.once('reply', { answers: ['m1', 'm2'] }, () => sent.push('B: answer to m1+m2'));
    expect(r1).toMatchObject({ status: 'refused', reason: 'conversation_changed' });
    expect(r1.status === 'refused' && r1.conflicts?.[0]).toMatchObject({ status: 'pending', summary: 'answer to m1' });

    g.open();
    await aReply;
    // A's reply has now landed, after B's last look: refused again so B re-reads.
    const r2 = await b.once('reply', { answers: ['m2'] }, () => sent.push('B: answer to m2'));
    expect(r2).toMatchObject({ status: 'refused', reason: 'conversation_changed' });
    expect(r2.status === 'refused' && r2.conflicts?.[0]?.status).toBe('committed');
    // B has seen everything now; its re-decided reply goes through.
    expect((await b.once('reply', { answers: ['m2'] }, () => sent.push('B: answer to m2'))).status).toBe('executed');
    expect(sent).toEqual(['A: answer to m1', 'B: answer to m2']);
  });

  it('uses contextAt to catch a write that landed between snapshot and start', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const snapshotAt = Date.now() - 50;
    const a = await ro.begin(conv, { contextAt: snapshotAt - 100 });
    await a.once('reply', ['m1'], () => 'a');
    const b = await ro.begin(conv, { contextAt: snapshotAt });
    expect(await b.once('reply', ['m1', 'm2'], () => 'b')).toMatchObject({
      status: 'refused',
      reason: 'conversation_changed',
    });
    const c = await ro.begin(uid());
    expect((await c.once('reply', 1, () => 1)).status).toBe('executed');
  });

  it('does not report writes that landed before the run started', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const a = await ro.begin(conv);
    await a.once('reply', ['m1'], () => 'a');
    await a.end();
    const b = await ro.begin(conv);
    expect((await b.once('reply', ['m2'], () => 'b')).status).toBe('executed');
  });

  it('supports narrower conflict modes and opting out of the ack', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const g = gate();
    const a = await ro.begin(conv);
    let started = false;
    const tagging = a.once('add_tag', 'vip', async () => {
      started = true;
      await g.p;
    });
    await until(() => started);
    const b = await ro.begin(conv);
    expect((await b.once('set_status', 'open', () => 1, { conflict: 'same-intent' })).status).toBe('executed');
    expect((await b.once('add_tag', 'other', () => 1, { conflict: 'none' })).status).toBe('executed');
    const noAck = () => b.once('reply', 1, () => 1, { ack: false });
    expect((await noAck()).status).toBe('refused');
    expect((await noAck()).status).toBe('refused');
    g.open();
    await tagging;
  });

  it("does not treat a run's own earlier writes as conflicts", async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const a = await ro.begin(uid());
    expect((await a.once('reply', 1, () => 1)).status).toBe('executed');
    expect((await a.once('add_tag', 'answered', () => 1)).status).toBe('executed');
    expect((await a.once('reply', 2, () => 2)).status).toBe('executed');
  });

  it('passes the run fencing token to the effect', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const run = await ro.begin(uid());
    await run.once('x', 1, (ctx) => {
      expect(ctx.fencingToken).toBe(run.fencingToken);
    });
  });
});

eachStore('redelivery', (makeStore) => {
  it('a redelivery resumes the run, fences the earlier delivery and replays done work', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    let sends = 0;
    const first = await ro.begin(conv, { runId: 'job-7' });
    await first.once('reply', { to: 'm1' }, () => ++sends);

    const second = await ro.begin(conv, { runId: 'job-7' });
    expect(second.state).toBe('resumed');
    expect(second.alreadyWrote).toBe(true);
    expect(second.priorEffects).toHaveLength(1);
    expect(second.fencingToken!).toBeGreaterThan(first.fencingToken!);

    expect(await second.once('reply', { to: 'm1' }, () => ++sends)).toMatchObject({ status: 'replayed', value: 1 });
    expect(await first.once('add_tag', 'x', () => 1)).toMatchObject({ status: 'refused', reason: 'superseded' });
    expect(await first.heartbeat()).toBe(false);
    await first.end();
    expect((await second.once('add_tag', 'x', () => 1)).status).toBe('executed');
    expect(sends).toBe(1);
  });

  it('redelivering an older run does not take the conversation from a newer one', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const t = Date.now() - 10;
    await ro.begin(conv, { runId: 'older', contextAt: t - 1 });
    const newer = await ro.begin(conv, { runId: 'newer', contextAt: t });
    // The redelivery gets the highest fencing token, but supersession follows context time.
    const redelivered = await ro.begin(conv, { runId: 'older', contextAt: t - 1 });
    expect(redelivered.fencingToken!).toBeGreaterThan(newer.fencingToken!);
    expect(redelivered.state).toBe('superseded');
    expect((await newer.once('reply', { to: 'm2' }, () => 1)).status).toBe('executed');
  });

  it('redelivering a run does not take the conversation from a peer with the same context time', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const t = Date.now() - 10;
    await ro.begin(conv, { runId: 'first', contextAt: t });
    const peer = await ro.begin(conv, { runId: 'second', contextAt: t });
    const redelivered = await ro.begin(conv, { runId: 'first', contextAt: t });
    expect(redelivered.state).toBe('resumed');
    expect((await peer.once('reply', { to: 'm2' }, () => 1)).status).toBe('executed');
  });

  it('a redelivery that would redo an intent differently is told the conversation changed', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const first = await ro.begin(conv, { runId: 'job-8' });
    await first.once('reply', { answers: ['m2'] }, () => 'narrow');
    const second = await ro.begin(conv, { runId: 'job-8' });
    // Other steps are not blocked by the earlier delivery's reply...
    expect((await second.once('add_tag', 'done', () => 1)).status).toBe('executed');
    // ...and writing them does not hide that reply from a reworded one.
    expect(await second.once('reply', { answers: ['m1', 'm2'] }, () => 'wide')).toMatchObject({
      status: 'refused',
      reason: 'conversation_changed',
    });
  });

  it('a write under a narrow conflict mode does not hide unseen writes from a later check', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const b = await ro.begin(conv);
    // A write on the conversation from outside any run (it never supersedes b).
    await ro.once({ scope: conv, intent: 'add_tag', payload: 'vip' }, () => 1);
    expect((await b.once('set_status', 'open', () => 1, { conflict: 'same-intent' })).status).toBe('executed');
    expect(await b.once('reply', 1, () => 1)).toMatchObject({ status: 'refused', reason: 'conversation_changed' });
  });
});

eachStore('exclusive leases', (makeStore) => {
  it('one holder at a time; takeover after expiry fences the stale holder', async () => {
    const clock = fakeClock();
    const ro = createReplyOnce({ store: await makeStore(), clock: clock.now, leaseTtlMs: 1_000 });
    const conv = uid();
    const a = await ro.begin(conv, { mode: 'exclusive', runId: 'worker-a' });
    const b = await ro.begin(conv, { mode: 'exclusive', runId: 'worker-b' });
    expect(a.state).toBe('new');
    expect(b.state).toBe('busy');
    expect(b.busyHolder?.runId).toBe('worker-a');
    expect(await b.once('x', 1, () => 1)).toMatchObject({ status: 'refused', reason: 'busy' });
    expect(await b.heartbeat()).toBe(false);

    clock.advance(600);
    expect(await a.heartbeat()).toBe(true);
    clock.advance(600);
    expect((await ro.begin(conv, { mode: 'exclusive', runId: 'worker-c' })).state).toBe('busy');

    clock.advance(1_001);
    const c = await ro.begin(conv, { mode: 'exclusive', runId: 'worker-c' });
    expect(c.state).toBe('new');
    expect(c.fencingToken!).toBeGreaterThan(a.fencingToken!);
    expect(await a.once('x', 1, () => 'stale')).toMatchObject({ status: 'refused', reason: 'superseded' });
    expect((await c.once('x', 1, () => 'fresh')).status).toBe('executed');
  });

  it('a holder that ends releases the scope', async () => {
    const ro = createReplyOnce({ store: await makeStore() });
    const conv = uid();
    const a = await ro.begin(conv, { mode: 'exclusive' });
    await a.end();
    expect((await ro.begin(conv, { mode: 'exclusive' })).state).toBe('new');
  });
});
