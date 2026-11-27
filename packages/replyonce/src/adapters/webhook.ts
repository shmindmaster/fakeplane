import type { Effect, OnceOptions, ReplyOnce } from '../replyonce.js';
import type { OnceResult } from '../types.js';

export interface WebhookOnceInput extends OnceOptions {
  /** Usually the conversation, ticket or channel the event belongs to. */
  scope: string;
  /** The provider's stable id for the event (for example Slack's `event_id`). */
  eventId: string;
  /** Ledger intent. Default `webhook`. */
  intent?: string;
}

export interface WebhookOnceResponse<T> {
  result: OnceResult<T>;
  /** Suggested HTTP status for the provider. See `httpStatusFor`. */
  status: number;
  /** Seconds, set when the provider should retry later. */
  retryAfter?: number;
}

/**
 * Suggested response so at-least-once delivery keeps working without duplicating effects:
 *
 * - executed / replayed: 200, the event is handled.
 * - in_flight: 503 + Retry-After. Another delivery is still processing it; if that one
 *   crashes, the provider's retry picks it up.
 * - failed and retryable: 500, let the provider retry.
 * - ambiguous, exhausted, or refused: 200. Redelivery cannot fix these; alert and reconcile.
 */
export function httpStatusFor(result: OnceResult<unknown>): { status: number; retryAfter?: number } {
  switch (result.status) {
    case 'executed':
    case 'replayed':
      return { status: 200 };
    case 'in_flight':
      return { status: 503, retryAfter: 5 };
    case 'failed':
      return result.retryable ? { status: 500 } : { status: 200 };
    default:
      return { status: 200 };
  }
}

/** Handle one webhook delivery at most once per (scope, eventId), however often it is redelivered. */
export async function webhookOnce<T>(
  ro: ReplyOnce,
  input: WebhookOnceInput,
  handler: Effect<T>,
): Promise<WebhookOnceResponse<T>> {
  const { scope, eventId, intent = 'webhook', ...options } = input;
  const result = await ro.once({ scope, intent, payload: { eventId } }, handler, options);
  return { result, ...httpStatusFor(result) };
}
