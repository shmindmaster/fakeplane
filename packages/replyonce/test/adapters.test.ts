import { describe, expect, it } from 'vitest';
import {
  ScopeBusyError,
  checkTool,
  describeOutcome,
  dispatchTool,
  guardTool,
  httpStatusFor,
  onceProcessor,
  toAnthropicTool,
  toOpenAITool,
  webhookOnce,
} from '../src/adapters/index.js';
import type { JobLike } from '../src/adapters/index.js';
import { MemoryStore, NotApplied, createReplyOnce } from '../src/index.js';
import { uid } from './helpers.js';

const replyTool = (sent: string[]) =>
  guardTool<{ inReplyTo: string; text: string }, { messageId: string }>({
    name: 'send_reply',
    description: 'Send a reply to the customer.',
    parameters: {
      type: 'object',
      properties: { inReplyTo: { type: 'string' }, text: { type: 'string' } },
      required: ['inReplyTo', 'text'],
    },
    identity: (a) => ({ inReplyTo: a.inReplyTo }),
    summarize: (a) => a.text,
    execute: (a) => {
      sent.push(a.text);
      return { messageId: `msg-${sent.length}` };
    },
  });

describe('tool adapter', () => {
  it('dedupes by business identity, not by model wording', async () => {
    const ro = createReplyOnce({ store: new MemoryStore() });
    const sent: string[] = [];
    const tool = replyTool(sent);
    const run = await ro.begin(uid());
    const r1 = await tool.call(run, { inReplyTo: 'm1', text: 'Your refund is on its way.' });
    const r2 = await tool.call(run, { inReplyTo: 'm1', text: 'Good news: refund issued!' });
    expect(r1).toMatchObject({ ok: true, status: 'executed', output: { messageId: 'msg-1' } });
    expect(r2).toMatchObject({ ok: true, status: 'replayed', output: { messageId: 'msg-1' } });
    expect(r2.message).toMatch(/already done/);
    expect(sent).toEqual(['Your refund is on its way.']);
  });

  it('tells the model what changed, and stops a superseded run', async () => {
    const ro = createReplyOnce({ store: new MemoryStore() });
    const sent: string[] = [];
    const tool = replyTool(sent);
    const conv = uid();
    const older = await ro.begin(conv);
    let release!: () => void;
    const slow = guardTool<{ inReplyTo: string; text: string }, void>({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      identity: tool.identity,
      summarize: (a) => a.text,
      execute: async (a) => {
        await new Promise<void>((r) => (release = r));
        sent.push(a.text);
      },
    });
    const pending = slow.call(older, { inReplyTo: 'm1', text: 'Answer to m1' });
    await new Promise((r) => setTimeout(r, 10));
    const newer = await ro.begin(conv);
    const refused = await tool.call(newer, { inReplyTo: 'm2', text: 'Answer to m1 and m2' });
    expect(refused).toMatchObject({ ok: false, terminal: false, retryable: true });
    expect(refused.conflicts?.[0]).toMatchObject({ summary: 'Answer to m1', status: 'pending' });
    release();
    await pending;
    expect(await tool.call(older, { inReplyTo: 'm3', text: 'late' })).toMatchObject({ ok: false, terminal: true });
  });

  it('exposes a read-only "already done?" tool', async () => {
    const ro = createReplyOnce({ store: new MemoryStore() });
    const sent: string[] = [];
    const tool = replyTool(sent);
    const check = checkTool([tool]);
    const run = await ro.begin(uid());
    expect((await check.call(run, { tool: 'send_reply', arguments: { inReplyTo: 'm1' } })).message).toBe('Not done yet.');
    await tool.call(run, { inReplyTo: 'm1', text: 'hi' });
    const found = await check.call(run, { tool: 'send_reply', arguments: { inReplyTo: 'm1', text: 'other words' } });
    expect(found).toMatchObject({ ok: true, output: { status: 'committed', done: true, summary: 'hi' } });
    const listed = await check.call(run, { tool: 'send_reply' });
    expect(listed.output).toHaveLength(1);
    expect((await check.call(run, { tool: 'nope' })).ok).toBe(false);
    expect(check.parameters).toMatchObject({ properties: { tool: { enum: ['send_reply'] } } });
  });

  it('dispatches by tool name and formats provider tool shapes', async () => {
    const ro = createReplyOnce({ store: new MemoryStore() });
    const tool = replyTool([]);
    const run = await ro.begin(uid());
    expect((await dispatchTool(run, [tool], 'send_reply', { inReplyTo: 'm', text: 't' })).ok).toBe(true);
    expect((await dispatchTool(run, [tool], 'missing', {})).ok).toBe(false);
    expect(toOpenAITool(tool)).toEqual({
      type: 'function',
      function: { name: 'send_reply', description: tool.description, parameters: tool.parameters },
    });
    expect(toOpenAITool(tool, 'responses')).toMatchObject({ type: 'function', name: 'send_reply' });
    expect(toAnthropicTool(tool)).toEqual({ name: 'send_reply', description: tool.description, input_schema: tool.parameters });
  });

  it('describes every outcome for the model', () => {
    const entry = {} as never;
    expect(describeOutcome({ status: 'in_flight', ok: false, key: 'k', entry }).retryable).toBe(false);
    expect(describeOutcome({ status: 'ambiguous', ok: false, key: 'k', entry }).message).toMatch(/unknown/);
    expect(describeOutcome({ status: 'failed', ok: false, key: 'k', attempt: 1, error: new Error('x'), retryable: true }).retryable).toBe(true);
    expect(describeOutcome({ status: 'refused', ok: false, key: 'k', reason: 'exhausted' }).terminal).toBe(false);
    expect(describeOutcome({ status: 'refused', ok: false, key: 'k', reason: 'run_cancelled' }).terminal).toBe(true);
  });
});

describe('webhook adapter', () => {
  it('handles a redelivered event once and suggests HTTP statuses', async () => {
    const ro = createReplyOnce({ store: new MemoryStore() });
    let handled = 0;
    const input = { scope: uid('ticket'), eventId: 'evt-1' };
    const a = await webhookOnce(ro, input, () => ++handled);
    const b = await webhookOnce(ro, input, () => ++handled);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.result.status).toBe('replayed');
    expect(handled).toBe(1);
    const entry = {} as never;
    expect(httpStatusFor({ status: 'in_flight', ok: false, key: 'k', entry })).toEqual({ status: 503, retryAfter: 5 });
    expect(httpStatusFor({ status: 'failed', ok: false, key: 'k', attempt: 1, error: 0, retryable: true }).status).toBe(500);
    expect(httpStatusFor({ status: 'failed', ok: false, key: 'k', attempt: 3, error: 0, retryable: false }).status).toBe(200);
    expect(httpStatusFor({ status: 'ambiguous', ok: false, key: 'k', entry }).status).toBe(200);
    const failed = await webhookOnce(ro, { scope: input.scope, eventId: 'evt-2' }, () => {
      throw new NotApplied('downstream 400');
    });
    expect(failed.status).toBe(500);
  });
});

describe('BullMQ adapter', () => {
  const convOf = (j: JobLike<{ conv: string }>) => j.data.conv;
  const job = (id: string, conv: string, attemptsMade = 0): JobLike<{ conv: string }> => ({
    id,
    data: { conv },
    attemptsMade,
    opts: { attempts: 3 },
  });

  it('resumes a retried job without repeating completed effects', async () => {
    const ro = createReplyOnce({ store: new MemoryStore() });
    const sent: string[] = [];
    let failOnce = true;
    const processor = onceProcessor(ro, { scope: convOf }, async (_j, run) => {
      await run.once('reply', { to: 'm1' }, () => sent.push('reply'));
      if (failOnce) {
        failOnce = false;
        throw new Error('worker crashed after replying');
      }
      await run.once('close', { ticket: 1 }, () => sent.push('close'));
      return 'ok';
    });
    const conv = uid();
    await expect(processor(job('1', conv, 0))).rejects.toThrow(/crashed/);
    expect(await processor(job('1', conv, 1))).toBe('ok');
    expect(sent).toEqual(['reply', 'close']);
    expect(await processor(job('1', conv, 2))).toEqual({ replyonce: 'skipped', reason: 'ended' });
  });

  it('can refuse to re-run a job that already wrote', async () => {
    const ro = createReplyOnce({ store: new MemoryStore() });
    const skips: string[] = [];
    const processor = onceProcessor(
      ro,
      { scope: convOf, onRedeliveredAfterWrite: 'skip', onSkip: (_j, r) => skips.push(r) },
      async (_j, run) => {
        await run.once('reply', 1, () => 1);
        throw new Error('boom');
      },
    );
    const conv = uid();
    await expect(processor(job('9', conv))).rejects.toThrow('boom');
    expect(await processor(job('9', conv, 1))).toEqual({ replyonce: 'skipped', reason: 'redelivered_after_write' });
    expect(skips).toEqual(['redelivered_after_write']);
  });

  it('skips a superseded job and throws ScopeBusyError in exclusive mode', async () => {
    const ro = createReplyOnce({ store: new MemoryStore() });
    const conv = uid();
    await ro.begin(conv, { runId: 'newer', contextAt: Date.now() });
    const processor = onceProcessor(ro, { scope: convOf }, async () => 'ran');
    // The job's run started earlier than the newer one: emulate an old job by pre-registering it.
    await ro.begin(conv, { runId: 'older', contextAt: Date.now() - 10_000 });
    expect(await processor(job('older', conv))).toEqual({ replyonce: 'skipped', reason: 'superseded' });

    const exclusive = onceProcessor(ro, { scope: convOf, mode: 'exclusive' }, async () => 'ran');
    const conv2 = uid();
    await ro.begin(conv2, { mode: 'exclusive', runId: 'holder' });
    await expect(exclusive(job('other', conv2))).rejects.toBeInstanceOf(ScopeBusyError);
  });

  it('marks the run failed on the final attempt', async () => {
    const ro = createReplyOnce({ store: new MemoryStore() });
    const processor = onceProcessor(ro, { scope: convOf }, async () => {
      throw new Error('always');
    });
    const conv = uid();
    await expect(processor(job('5', conv, 2))).rejects.toThrow('always');
    expect((await ro.begin(conv, { runId: '5' })).state).toBe('ended');
  });
});
