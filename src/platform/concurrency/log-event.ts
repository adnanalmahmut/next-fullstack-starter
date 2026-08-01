/**
 * Stable log event names for the concurrency controls.
 *
 * They are language-neutral identifiers, not user-facing text. The fields a line
 * may carry are the shared control allowlist and nothing else: never a Redis
 * key, an `Idempotency-Key`, a request fingerprint, a lock token, a caller's
 * address, an input, an output, or a raw error.
 *
 * The level is chosen by what an operator would do about the line. A refusal is
 * expected traffic and is recorded at `debug`; a control that could not run at
 * all is a `warn`, because it means a protection the code asked for was not
 * applied.
 */
export const CONCURRENCY_LOG_EVENT = {
  RATE_LIMIT_ALLOWED: "rate_limit.allowed",
  RATE_LIMIT_REFUSED: "rate_limit.refused",
  RATE_LIMIT_UNAVAILABLE: "rate_limit.unavailable",

  IDEMPOTENCY_ACQUIRED: "idempotency.acquired",
  IDEMPOTENCY_REPLAYED: "idempotency.replayed",
  IDEMPOTENCY_CONFLICT: "idempotency.conflict",
  IDEMPOTENCY_UNAVAILABLE: "idempotency.unavailable",
  IDEMPOTENCY_COMPLETED: "idempotency.completed",
  IDEMPOTENCY_ABORTED: "idempotency.aborted",

  LOCK_ACQUIRED: "lock.acquired",
  LOCK_CONTENDED: "lock.contended",
  LOCK_TIMEOUT: "lock.timeout",
  LOCK_UNAVAILABLE: "lock.unavailable",
  LOCK_RELEASED: "lock.released",
  LOCK_RELEASE_FAILED: "lock.release_failed",
} as const;

export type ConcurrencyLogEvent =
  (typeof CONCURRENCY_LOG_EVENT)[keyof typeof CONCURRENCY_LOG_EVENT];

/** The operations a concurrency log line can be attributed to. */
export const CONCURRENCY_OPERATION = {
  RATE_LIMIT: "rate-limit",
  IDEMPOTENCY: "idempotency",
  LOCK: "lock",
} as const;

export type ConcurrencyOperation =
  (typeof CONCURRENCY_OPERATION)[keyof typeof CONCURRENCY_OPERATION];
