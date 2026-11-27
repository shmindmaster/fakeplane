/**
 * A BullMQ worker whose first attempt replies to the customer and then crashes. BullMQ
 * retries the job; replyonce resumes the run and the reply is not sent again.
 *
 * Needs Redis:  REDIS_URL=redis://localhost:6379 npx tsx examples/bullmq-worker.ts
 */
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createReplyOnce } from 'replyonce';
import { onceProcessor } from 'replyonce/adapters';
import type { JobLike } from 'replyonce/adapters';
import { RedisStore } from 'replyonce/redis';

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = new Redis(url, { maxRetriesPerRequest: null });
const ro = createReplyOnce({ store: new RedisStore({ client: connection, prefix: 'replyonce-example' }) });

const queueName = `replies-${Date.now()}`;
const queue = new Queue(queueName, { connection });
const sent: string[] = [];

type ReplyJob = { conversationId: string; messageId: string };

const processor = onceProcessor(
  ro,
  { scope: (job: JobLike<ReplyJob>) => job.data.conversationId },
  async (job, run) => {
    await run.once('reply', { inReplyTo: job.data.messageId }, async () => {
      sent.push(`reply to ${job.data.messageId}`);
    });
    if (job.attemptsMade === 0) throw new Error('worker crashed after replying');
    await run.once('close_ticket', { conversation: job.data.conversationId }, async () => {
      sent.push('ticket closed');
    });
    return 'done';
  },
);

async function main() {
  const finished = new Promise<void>((resolve) => {
    const worker = new Worker(queueName, processor, { connection });
    worker.on('failed', (job, err) => console.log(`attempt ${job?.attemptsMade} failed: ${err.message}`));
    worker.on('completed', async (job, result) => {
      console.log(`job ${job.id} completed:`, result);
      await worker.close();
      resolve();
    });
  });
  // A fresh conversation per run: the ledger in Redis outlives this script.
  const conversationId = `conversation-${Date.now()}`;
  await queue.add('reply', { conversationId, messageId: 'msg-1' }, { attempts: 3, backoff: { type: 'fixed', delay: 100 } });
  await finished;
  console.log('effects:', sent);
  await queue.obliterate({ force: true });
  await queue.close();
  connection.disconnect();
  if (sent.filter((s) => s.startsWith('reply')).length !== 1) process.exit(1);
}

main();
