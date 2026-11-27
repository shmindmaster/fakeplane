/**
 * A tool-calling agent loop (OpenAI Chat Completions message shapes) where the model
 * calls `send_reply` twice for the same customer message, the way a retried or confused
 * agent does, and a `refund` that times out after the provider applied it.
 *
 * Runs offline: the "model" is scripted. Swap `scriptedModel` for a real
 * `openai.chat.completions.create({ model, messages, tools })` call; the tool plumbing is the same.
 * For Anthropic, pass `tools.map(toAnthropicTool)` and read `tool_use` content blocks instead.
 *
 *   npx tsx examples/agent-loop.ts
 */
import { MemoryStore, createReplyOnce } from 'replyonce';
import { checkTool, dispatchTool, guardTool, toOpenAITool } from 'replyonce/adapters';

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const outbox: string[] = [];
const refundsIssued: string[] = [];

const sendReply = guardTool<{ in_reply_to: string; text: string }, { message_id: string }>({
  name: 'send_reply',
  description: 'Send a reply to the customer on this conversation.',
  parameters: {
    type: 'object',
    properties: { in_reply_to: { type: 'string' }, text: { type: 'string' } },
    required: ['in_reply_to', 'text'],
  },
  // Same action = answering the same inbound message, however the model words it.
  identity: (a) => ({ inReplyTo: a.in_reply_to }),
  summarize: (a) => a.text,
  execute: async (a) => {
    outbox.push(a.text);
    return { message_id: `out-${outbox.length}` };
  },
});

let refundCalls = 0;
const refund = guardTool<{ order_id: string; cents: number }, { refund_id: string }>({
  name: 'refund',
  description: 'Refund an order.',
  parameters: {
    type: 'object',
    properties: { order_id: { type: 'string' }, cents: { type: 'integer' } },
    required: ['order_id', 'cents'],
  },
  identity: (a) => ({ order: a.order_id, cents: a.cents }),
  summarize: (a) => `refund ${a.cents} cents on ${a.order_id}`,
  execute: async (a, ctx) => {
    // A real provider call would send ctx.idempotencyKey (for example as Idempotency-Key).
    refundCalls++;
    refundsIssued.push(`${a.order_id}:${ctx.idempotencyKey}`);
    if (refundCalls === 1) throw new Error('ETIMEDOUT'); // applied, but we never heard back
    return { refund_id: 're_123' };
  },
});

const tools = [sendReply, refund];
const allTools = [...tools, checkTool(tools)];

// The reconciler asks the "provider" whether an ambiguous refund actually happened.
const ro = createReplyOnce({
  store: new MemoryStore(),
  reconcile: async (entry) =>
    entry.intent === 'refund' && refundsIssued.length > 0 ? { outcome: 'committed', result: { refund_id: 're_123' } } : { outcome: 'unknown' },
});

/** A scripted model that repeats itself, like real agents under retries. */
function scriptedModel(turn: number): Message {
  const call = (id: string, name: string, args: unknown): ToolCall => ({
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });
  const script: Message[] = [
    { role: 'assistant', content: null, tool_calls: [call('c1', 'refund', { order_id: 'A-1001', cents: 2500 })] },
    // The refund timed out, so the model tries again.
    { role: 'assistant', content: null, tool_calls: [call('c2', 'refund', { order_id: 'A-1001', cents: 2500 })] },
    { role: 'assistant', content: null, tool_calls: [call('c3', 'send_reply', { in_reply_to: 'msg-1', text: 'Your refund of $25 is on its way.' })] },
    // A retry of the turn re-sends a reworded reply to the same message.
    { role: 'assistant', content: null, tool_calls: [call('c4', 'send_reply', { in_reply_to: 'msg-1', text: 'Good news! $25 refunded.' })] },
    { role: 'assistant', content: 'All set.' },
  ];
  return script[Math.min(turn, script.length - 1)]!;
}

async function main() {
  const run = await ro.begin('conversation-42', { runId: 'inbound-msg-1' });
  const messages: Message[] = [
    { role: 'system', content: 'You are a support agent.' },
    { role: 'user', content: 'My order A-1001 arrived broken, please refund it.' },
  ];
  console.log('tools sent to the model:', allTools.map((t) => (toOpenAITool(t) as { function: { name: string } }).function.name));

  for (let turn = 0; turn < 10; turn++) {
    const reply = scriptedModel(turn);
    messages.push(reply);
    if (reply.role !== 'assistant' || !reply.tool_calls?.length) break;
    for (const call of reply.tool_calls) {
      const outcome = await dispatchTool(run, allTools, call.function.name, JSON.parse(call.function.arguments));
      console.log(`${call.function.name} -> ${outcome.status}: ${outcome.message}`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome) });
      if (outcome.terminal) return;
    }
  }
  await run.end();
  console.log(`\nreplies the customer received: ${outbox.length}`, outbox);
  console.log(`refunds issued: ${refundsIssued.length}`);
}

main();
