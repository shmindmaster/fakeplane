import { providerIdempotencyKey } from './key.js';
import { createReplyOnce } from './replyonce.js';
import { MemoryStore } from './stores/memory.js';
import type { Store } from './types.js';

/**
 * A chaos simulation of a support agent answering customer messages through a queue.
 *
 * Faults: provider timeouts after the message was sent, timeouts before it was sent,
 * workers that crash after sending, duplicate queue delivery, and customers who send a
 * second message while the first is still being answered. The naive agent retries and
 * replays like most agents do. The guarded agent sends through replyonce.
 */

export interface DemoOptions {
  conversations?: number;
  seed?: number;
  store?: Store;
  /**
   * Run on the wall clock instead of simulated time. Simulated time makes every count a function
   * of the seed; real time explores timing a single seed cannot. Defaults to real time when a
   * `store` is passed (shared stores do real I/O) and simulated time otherwise.
   */
  realTime?: boolean;
}

interface DemoStats {
  conversations: number;
  customerMessages: number;
  repliesSent: number;
  duplicateAnswers: number;
  unanswered: number;
}

export interface DemoReport {
  without: DemoStats;
  with: DemoStats;
  faults: { without: Record<string, number>; with: Record<string, number> };
}

interface SentReply {
  conv: string;
  answers: string[];
  idem: string | null;
}

class TimeoutError extends Error {
  constructor() {
    super('provider timed out');
    this.name = 'TimeoutError';
  }
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hang = () => new Promise<never>(() => {});

interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const wallClock: Clock = { now: Date.now, sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)) };

/**
 * Simulated time: timers fire one at a time in deadline order (ties in the order they were set),
 * each only after every pending promise has settled. With the in-memory store nothing else can
 * interleave, so a seed always replays the same run, and no real time passes.
 */
class SimulatedClock implements Clock {
  private t = Date.UTC(2026, 0, 1);
  private seq = 0;
  private readonly timers: Array<{ at: number; seq: number; fire: () => void }> = [];
  readonly now = () => this.t;
  readonly sleep = (ms: number) =>
    new Promise<void>((fire) => {
      this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, fire });
    });

  async run<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    work.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (;;) {
      await new Promise<void>((r) => setImmediate(r));
      if (settled) return work;
      if (this.timers.length === 0) throw new Error('replyonce demo: the simulation stalled');
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift()!;
      this.t = next.at;
      next.fire();
    }
  }
}

interface Job {
  id: string;
  conv: string;
  msgId: string;
  /** What the run's context showed as already answered when the job was created. */
  answeredAtEnqueue: Set<string>;
  inboundAtEnqueue: string[];
  contextAt: number;
}

interface World {
  inbound: Map<string, string[]>;
  sent: SentReply[];
  faults: Record<string, number>;
  rand: () => number;
  clock: Clock;
}

function answered(world: World, conv: string): Set<string> {
  const s = new Set<string>();
  for (const r of world.sent) if (r.conv === conv) r.answers.forEach((a) => s.add(a));
  return s;
}

/** Provider send with injected faults. Like most chat APIs it does not dedupe. */
async function providerSend(world: World, reply: SentReply): Promise<void> {
  await world.clock.sleep(1 + world.rand() * 4);
  const roll = world.rand();
  if (roll < 0.15) {
    world.sent.push(reply);
    world.faults.timeoutAfterSend = (world.faults.timeoutAfterSend ?? 0) + 1;
    throw new TimeoutError();
  }
  if (roll < 0.25) {
    world.faults.timeoutBeforeSend = (world.faults.timeoutBeforeSend ?? 0) + 1;
    throw new TimeoutError();
  }
  world.sent.push(reply);
}

type Agent = (job: Job, crashAfterSend: boolean) => Promise<void>;

function naiveAgent(world: World): Agent {
  return async (job, crash) => {
    await world.clock.sleep(2 + world.rand() * 10);
    const todo = job.inboundAtEnqueue.filter((m) => !job.answeredAtEnqueue.has(m));
    if (todo.length === 0) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await providerSend(world, { conv: job.conv, answers: todo, idem: null });
        if (crash) await hang();
        return;
      } catch {
        // retry on any error
      }
    }
  };
}

function guardedAgent(world: World, store: Store): Agent {
  const ro = createReplyOnce({
    store,
    pendingTtlMs: 2_000,
    maxAttempts: 6,
    leaseTtlMs: 5_000,
    clock: world.clock.now,
    sleep: world.clock.sleep,
    // A settle after the claim was given up on means pendingTtlMs was too short for this host.
    onEvent: (e) => {
      if (e.type === 'late_settle') world.faults.lateSettle = (world.faults.lateSettle ?? 0) + 1;
    },
    // Look the message up on the provider by the idempotency key it was sent with.
    reconcile: async (entry) => {
      const idem = providerIdempotencyKey(entry.scope, entry.key);
      return world.sent.some((r) => r.idem === idem) ? { outcome: 'committed' } : { outcome: 'not_applied' };
    },
  });
  return async (job, crash) => {
    await world.clock.sleep(2 + world.rand() * 10);
    const run = await ro.begin(job.conv, { runId: job.id, contextAt: job.contextAt });
    if (!run.canWrite) return;
    let inbound = job.inboundAtEnqueue;
    let done = job.answeredAtEnqueue;
    const giveUpAt = world.clock.now() + 15_000;
    while (world.clock.now() < giveUpAt) {
      const todo = inbound.filter((m) => !done.has(m));
      if (todo.length === 0) break;
      const identity = { answers: todo };
      const res = await run.once(
        'reply',
        identity,
        async (ctx) => {
          await providerSend(world, { conv: job.conv, answers: todo, idem: ctx.idempotencyKey });
          if (crash) await hang();
        },
        { summary: `reply to ${todo.join(', ')}`, wait: { timeoutMs: 5_000, intervalMs: 10 } },
      );
      if (res.ok) break;
      if (res.status === 'refused' && res.reason === 'conversation_changed') {
        // Another run's reply may still be in flight; give it a moment, then re-read.
        await world.clock.sleep(res.conflicts?.some((c) => c.status === 'pending') ? 25 : 5);
        inbound = world.inbound.get(job.conv) ?? [];
        done = answered(world, job.conv);
        continue;
      }
      if (res.status === 'refused') break;
      await world.clock.sleep(10);
    }
    await run.end();
  };
}

type Outcome = DemoStats & { faults: Record<string, number> };

function simulate(conversations: number, seed: number, realTime: boolean, makeAgent: (w: World) => Agent): Promise<Outcome> {
  const clock = realTime ? wallClock : new SimulatedClock();
  const world: World = { inbound: new Map(), sent: [], faults: {}, rand: rng(seed), clock };
  // Shared stores outlive a run, so real-time runs keep their conversations apart.
  const ns = realTime ? Math.random().toString(36).slice(2, 10) : `seed${seed}`;
  const play = () => playOut(world, conversations, ns, makeAgent(world));
  return clock instanceof SimulatedClock ? clock.run(play()) : play();
}

async function playOut(world: World, conversations: number, ns: string, agent: Agent): Promise<Outcome> {
  const { sleep } = world.clock;
  const tasks: Promise<void>[] = [];
  let jobSeq = 0;

  const deliver = (job: Job) => {
    const r = world.rand();
    const crash = r < 0.1;
    const duplicate = r >= 0.1 && r < 0.25;
    if (crash) {
      world.faults.workerCrash = (world.faults.workerCrash ?? 0) + 1;
      void agent(job, true);
      tasks.push(sleep(60 + world.rand() * 60).then(() => agent(job, false)));
      return;
    }
    tasks.push(agent(job, false));
    if (duplicate) {
      world.faults.duplicateDelivery = (world.faults.duplicateDelivery ?? 0) + 1;
      tasks.push(sleep(world.rand() * 8).then(() => agent(job, false)));
    }
  };

  const enqueue = (conv: string, msgId: string) => {
    const list = world.inbound.get(conv) ?? [];
    list.push(msgId);
    world.inbound.set(conv, list);
    deliver({
      id: `job-${++jobSeq}`,
      conv,
      msgId,
      answeredAtEnqueue: answered(world, conv),
      inboundAtEnqueue: [...list],
      contextAt: world.clock.now(),
    });
  };

  for (let i = 0; i < conversations; i++) {
    const conv = `demo-${ns}-conversation-${i}`;
    enqueue(conv, `${conv}/m1`);
    if (world.rand() < 0.25) {
      world.faults.customerBurst = (world.faults.customerBurst ?? 0) + 1;
      tasks.push(sleep(1 + world.rand() * 12).then(() => enqueue(conv, `${conv}/m2`)));
    }
  }
  // Tasks may add more tasks (bursts enqueue jobs); drain until stable.
  for (let n = 0; n !== tasks.length; ) {
    n = tasks.length;
    await Promise.all(tasks.slice());
  }
  await sleep(50);

  let duplicateAnswers = 0;
  let unanswered = 0;
  let customerMessages = 0;
  for (const [conv, msgs] of world.inbound) {
    for (const m of msgs) {
      customerMessages++;
      const count = world.sent.filter((r) => r.conv === conv && r.answers.includes(m)).length;
      if (count === 0) unanswered++;
      if (count > 1) duplicateAnswers += count - 1;
    }
  }
  return {
    conversations,
    customerMessages,
    repliesSent: world.sent.length,
    duplicateAnswers,
    unanswered,
    faults: world.faults,
  };
}

export async function runDemo(options: DemoOptions = {}): Promise<DemoReport> {
  const conversations = options.conversations ?? 100;
  const seed = options.seed ?? 7;
  const realTime = options.realTime ?? options.store !== undefined;
  const { faults: withoutFaults, ...without } = await simulate(conversations, seed, realTime, naiveAgent);
  const store = options.store ?? new MemoryStore();
  const { faults: withFaults, ...guarded } = await simulate(conversations, seed, realTime, (w) => guardedAgent(w, store));
  return { without, with: guarded, faults: { without: withoutFaults, with: withFaults } };
}

/**
 * FORCE_COLOR turns colour on even when output is piped or recorded (FORCE_COLOR=0 or false turns it
 * off); otherwise NO_COLOR turns it off and a terminal turns it on. Same precedence as Node itself.
 */
export function shouldColor(env: NodeJS.ProcessEnv = process.env, isTTY = process.stdout.isTTY): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined) return !['0', 'false'].includes(force.trim().toLowerCase());
  if (env.NO_COLOR) return false;
  return Boolean(isTTY);
}

export interface FormatOptions {
  /** ANSI colour: duplicates and unanswered in red, zeroes and the verdict in green. */
  color?: boolean;
}

export function formatReport(r: DemoReport, options: FormatOptions = {}): string {
  const paint = (code: number) => (s: string) => (options.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const red = paint(31);
  const green = paint(32);
  const bold = paint(1);
  const count = (n: number, width: number) => (n === 0 ? green : red)(String(n).padStart(width));
  const row = (label: string, s: DemoStats) =>
    `  ${label.padEnd(16)} ${String(s.customerMessages).padStart(8)} ${String(s.repliesSent).padStart(7)} ${count(s.duplicateAnswers, 10)} ${count(s.unanswered, 11)}`;
  const faults = (f: Record<string, number>) =>
    Object.entries(f)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
  return [
    bold(`replyonce demo: ${r.without.conversations} simulated support conversations under injected faults`),
    `  without: ${faults(r.faults.without)}`,
    `  with:    ${faults(r.faults.with)}`,
    '',
    `  ${''.padEnd(16)} ${'messages'.padStart(8)} ${'replies'.padStart(7)} ${'duplicates'.padStart(10)} ${'unanswered'.padStart(11)}`,
    row('without', r.without),
    row('with replyonce', r.with),
    '',
    r.with.duplicateAnswers === 0
      ? green('  No customer message was answered twice with replyonce.')
      : red(
          r.faults.with.lateSettle
            ? '  Duplicates happened after this host stalled past pendingTtlMs (see lateSettle): the limit described in the README.'
            : '  Duplicates remained with replyonce. Please report this: https://github.com/shmindmaster/replyonce/issues',
        ),
  ].join('\n');
}