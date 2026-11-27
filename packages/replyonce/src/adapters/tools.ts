import type { ConflictMode } from '../logic.js';
import type { Run } from '../replyonce.js';
import type { ConflictInfo, EffectContext, OnceResult } from '../types.js';

export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface GuardedToolSpec<A, R> extends ToolDefinition {
  /** Ledger intent. Defaults to the tool name. */
  intent?: string;
  /**
   * The business identity of the action, from its arguments: what makes two calls "the
   * same action". For a reply, the inbound message being answered; for a refund, the
   * order and amount. Never the model's tool-call id.
   */
  identity: (args: A) => unknown;
  /** Short text other runs see if this write conflicts with theirs. */
  summarize?: (args: A) => string;
  conflict?: ConflictMode;
  execute: (args: A, ctx: EffectContext) => Promise<R> | R;
}

/** What to hand back to the model. `terminal` means the run should stop. */
export interface ToolOutcome {
  ok: boolean;
  status: OnceResult<unknown>['status'];
  terminal: boolean;
  retryable: boolean;
  message: string;
  output?: unknown;
  conflicts?: Array<Pick<ConflictInfo, 'intent' | 'status' | 'summary'>>;
}

export interface GuardedTool<A = any, R = unknown> extends ToolDefinition {
  intent: string;
  identity: (args: A) => unknown;
  call(run: Run, args: A): Promise<ToolOutcome>;
}

/** Wrap a side-effecting tool so a run executes it at most once per business identity. */
export function guardTool<A, R>(spec: GuardedToolSpec<A, R>): GuardedTool<A, R> {
  const intent = spec.intent ?? spec.name;
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    intent,
    identity: spec.identity,
    async call(run, args) {
      const result = await run.once(intent, spec.identity(args), (ctx) => spec.execute(args, ctx), {
        ...(spec.summarize ? { summary: spec.summarize(args) } : {}),
        ...(spec.conflict ? { conflict: spec.conflict } : {}),
      });
      return describeOutcome(result);
    },
  };
}

/** Turn a `once` result into a model-friendly tool result. */
export function describeOutcome(result: OnceResult<unknown>): ToolOutcome {
  switch (result.status) {
    case 'executed':
      return { ok: true, status: 'executed', terminal: false, retryable: false, message: 'Done.', output: result.value };
    case 'replayed':
      return {
        ok: true,
        status: 'replayed',
        terminal: false,
        retryable: false,
        message: 'This exact action was already done earlier. It was not repeated.',
        output: result.value,
      };
    case 'in_flight':
      return {
        ok: false,
        status: 'in_flight',
        terminal: false,
        retryable: false,
        message: 'This exact action is already in progress elsewhere. Do not repeat it.',
      };
    case 'ambiguous':
      return {
        ok: false,
        status: 'ambiguous',
        terminal: false,
        retryable: false,
        message:
          'This action may or may not have happened (the outcome is unknown). Do not repeat it. ' +
          'Tell the user it is being checked, or escalate to a human.',
      };
    case 'failed':
      return {
        ok: false,
        status: 'failed',
        terminal: false,
        retryable: result.retryable,
        message: result.retryable
          ? `The action failed and did not happen: ${errorText(result.error)}. You may retry.`
          : `The action failed and did not happen: ${errorText(result.error)}. Retry limit reached; escalate.`,
      };
    case 'refused': {
      switch (result.reason) {
        case 'conversation_changed':
          return {
            ok: false,
            status: 'refused',
            terminal: false,
            retryable: true,
            message:
              'Not done: the conversation changed since you last read it. Another run did the following. ' +
              'Re-read the conversation and decide whether your action is still needed; if it is, call the tool again.',
            conflicts: (result.conflicts ?? []).map((c) => ({ intent: c.intent, status: c.status, summary: c.summary })),
          };
        case 'exhausted':
          return {
            ok: false,
            status: 'refused',
            terminal: false,
            retryable: false,
            message: 'Not done: this action already failed too many times. Escalate to a human.',
          };
        default:
          return {
            ok: false,
            status: 'refused',
            terminal: true,
            retryable: false,
            message: `Stop: this run may no longer act on this conversation (${result.reason}).`,
          };
      }
    }
  }
}

/**
 * A read-only "was this already done?" tool. Given a guarded tool name and, optionally,
 * its arguments, it reports what the ledger knows. Add it alongside your write tools.
 */
export function checkTool(tools: GuardedTool[], name = 'check_already_done'): GuardedTool<{ tool: string; arguments?: unknown }, unknown> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    name,
    description:
      'Check whether a side-effecting action was already done on this conversation before doing it again. ' +
      'Pass the tool name and the arguments you would call it with. Omit arguments to list every recorded call of that tool.',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: tools.map((t) => t.name) },
        arguments: { type: 'object', description: 'The arguments you would pass to that tool.' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    intent: name,
    identity: (args) => args,
    async call(run, args) {
      const tool = byName.get(args?.tool);
      if (!tool) {
        return { ok: false, status: 'failed', terminal: false, retryable: false, message: `Unknown tool ${String(args?.tool)}.` };
      }
      if (args.arguments !== undefined) {
        const found = await run.check(tool.intent, tool.identity(args.arguments));
        const message =
          found.status === 'none'
            ? 'Not done yet.'
            : found.status === 'committed'
              ? 'Already done. Do not repeat it.'
              : found.status === 'failed'
                ? 'Tried before and it did not happen. It may be retried.'
                : found.status === 'pending'
                  ? 'In progress right now. Do not repeat it.'
                  : 'Outcome unknown. Do not repeat it; escalate.';
        return {
          ok: true,
          status: 'executed',
          terminal: false,
          retryable: false,
          message,
          output: { status: found.status, done: found.done, summary: found.entry?.summary ?? null },
        };
      }
      const all = (await run.history()).filter((e) => e.intent === tool.intent);
      return {
        ok: true,
        status: 'executed',
        terminal: false,
        retryable: false,
        message: all.length === 0 ? 'No calls recorded.' : `${all.length} call(s) recorded.`,
        output: all.map((e) => ({ status: e.status, summary: e.summary, at: new Date(e.settledAt ?? e.claimedAt).toISOString() })),
      };
    },
  };
}

/** Route a model's tool call to the matching guarded tool. */
export async function dispatchTool(run: Run, tools: GuardedTool[], name: string, args: unknown): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return { ok: false, status: 'failed', terminal: false, retryable: false, message: `Unknown tool ${name}.` };
  }
  return tool.call(run, args);
}

/** OpenAI tool shape. `chat` for Chat Completions, `responses` for the Responses API. */
export function toOpenAITool(tool: ToolDefinition, api: 'chat' | 'responses' = 'chat'): Record<string, unknown> {
  if (api === 'responses') {
    return { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters };
  }
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

/** Anthropic Messages API tool shape. */
export function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
