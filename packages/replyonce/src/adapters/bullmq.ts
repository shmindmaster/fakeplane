import type { ReplyOnce, Run } from '../replyonce.js';
import type { RunMode } from '../types.js';

/** The parts of a BullMQ `Job` replyonce reads. */
export interface JobLike<D = unknown> {
  id?: string;
  name?: string;
  queueName?: string;
  data: D;
  attemptsMade: number;
  opts?: { attempts?: number };
}

export interface OnceProcessorOptions<D> {
  /** Scope of the job, usually the conversation id. */
  scope: (job: JobLike<D>) => string;
  /**
   * Stable run id. Default: `<queueName>:<job id>`. BullMQ keeps the job id across retries
   * and stalled redelivery, but ids are only unique within one queue.
   */
  runId?: (job: JobLike<D>) => string;
  mode?: RunMode;
  /**
   * A redelivered job whose run already claimed a write. `resume` (default) runs the
   * processor again; every `run.once` it already completed is replayed, not repeated.
   * `skip` never re-runs it, for processors whose effect identities are not deterministic.
   */
  onRedeliveredAfterWrite?: 'resume' | 'skip';
  onSkip?: (job: JobLike<D>, reason: SkipReason) => void;
}

export type SkipReason = 'ended' | 'superseded' | 'redelivered_after_write';

export interface Skipped {
  replyonce: 'skipped';
  reason: SkipReason;
}

/** Thrown in `exclusive` mode while another live worker holds the scope, so the queue retries later. */
export class ScopeBusyError extends Error {
  readonly holderRunId: string;
  constructor(scope: string, holderRunId: string) {
    super(`replyonce: scope ${JSON.stringify(scope)} is held by run ${holderRunId}`);
    this.name = 'ScopeBusyError';
    this.holderRunId = holderRunId;
  }
}

/**
 * Wrap a BullMQ processor. Each job becomes a replyonce run keyed by job id, so retries
 * and stalled-job redelivery resume the same run and its completed effects are not redone.
 */
export function onceProcessor<D, R>(
  ro: ReplyOnce,
  options: OnceProcessorOptions<D>,
  processor: (job: JobLike<D>, run: Run) => Promise<R>,
): (job: JobLike<D>) => Promise<R | Skipped> {
  return async (job) => {
    const scope = options.scope(job);
    if (!options.runId && !job.id) throw new TypeError('replyonce: job has no id; pass options.runId');
    const runId = options.runId ? options.runId(job) : job.queueName ? `${job.queueName}:${job.id}` : job.id!;
    const run = await ro.begin(scope, { runId, ...(options.mode ? { mode: options.mode } : {}) });

    const skip = (reason: SkipReason): Skipped => {
      options.onSkip?.(job, reason);
      return { replyonce: 'skipped', reason };
    };
    if (run.state === 'busy') throw new ScopeBusyError(scope, run.busyHolder!.runId);
    if (run.state === 'ended') return skip('ended');
    if (run.state === 'superseded') {
      await run.end('cancelled');
      return skip('superseded');
    }
    if (run.state === 'resumed' && run.alreadyWrote && options.onRedeliveredAfterWrite === 'skip') {
      await run.end('failed');
      return skip('redelivered_after_write');
    }

    try {
      const out = await processor(job, run);
      await run.end('completed');
      return out;
    } catch (err) {
      const attempts = job.opts?.attempts ?? 1;
      if (job.attemptsMade + 1 >= attempts) await run.end('failed').catch(() => undefined);
      throw err;
    }
  };
}
