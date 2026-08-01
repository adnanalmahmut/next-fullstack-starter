import { OutboxDeadLetterCode } from "@/generated/prisma/enums";

/**
 * The vocabulary of an outbox row's lifecycle.
 *
 * A row is *pending* until it is published, and it leaves that state in exactly
 * two ways: `publishedAt` is set, or it is dead-lettered. Nothing deletes a row,
 * so "what happened to that message" always has an answer.
 */
export const OUTBOX_DEAD_LETTER_CODE = OutboxDeadLetterCode;

export type OutboxDeadLetterReason =
  (typeof OUTBOX_DEAD_LETTER_CODE)[keyof typeof OUTBOX_DEAD_LETTER_CODE];

export const OUTBOX_DEAD_LETTER_CODES: readonly OutboxDeadLetterReason[] =
  Object.values(OUTBOX_DEAD_LETTER_CODE);

/**
 * The closed set of publish failures a row may record.
 *
 * `lastErrorCode` is a column, and a column that could hold an exception message
 * would eventually hold a connection string. These are the only values written
 * to it.
 */
export const OUTBOX_ERROR_CODE = {
  /** The queue could not be built: jobs are off, or no URL is configured. */
  QUEUE_UNAVAILABLE: "queue-unavailable",
  /** The queue exists but would not accept the message. Usually Redis is down. */
  PUBLISH_FAILED: "publish-failed",
  /** Another dispatcher published this row first; this one lost the race. */
  LEASE_LOST: "lease-lost",
} as const;

export type OutboxErrorCode =
  (typeof OUTBOX_ERROR_CODE)[keyof typeof OUTBOX_ERROR_CODE];

/**
 * The ceiling on a publish backoff.
 *
 * Doubling has to stop somewhere or a row that failed twenty times would come
 * back in a fortnight. Fifteen minutes keeps a recovered Redis draining the
 * backlog within one operator's attention span.
 */
export const MAX_OUTBOX_BACKOFF_MS = 15 * 60 * 1_000;

/**
 * How long to wait before the next publish attempt.
 *
 * Exponential in the number of attempts already made, capped, and with a small
 * deterministic spread derived from the row's own identifier. The spread matters
 * with more than one dispatcher: without it, a Redis outage lines every failed
 * row up on the same millisecond and the recovery is a thundering herd.
 */
export function outboxBackoffDelayMs(
  attempts: number,
  baseMs: number,
  seed = "",
): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  const delay = Math.min(baseMs * 2 ** exponent, MAX_OUTBOX_BACKOFF_MS);

  // Up to a tenth of the delay, chosen by the seed rather than by a random
  // number, so the same row always waits the same amount and a test can assert
  // it.
  const spread = Math.floor(delay / 10);

  if (spread === 0 || seed.length === 0) {
    return delay;
  }

  let hash = 0;

  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) % 100_000;
  }

  return delay + (hash % spread);
}
