import "server-only";

/**
 * The controlled server-only entry point for the concurrency controls.
 *
 * Three controls live behind it — a rate limiter, an idempotency lifecycle, and
 * a lease lock — and they share one property: every one of them is optional, and
 * every use of one names what should happen when it is not there.
 *
 * None of them is a correctness mechanism. PostgreSQL remains the source of
 * truth: a unique constraint, a transaction, and a durable idempotency record
 * are what make an operation correct, and these controls only make it cheaper
 * and less contended.
 */
export {
  AVAILABILITY_POLICIES,
  AVAILABILITY_POLICY,
  RATE_LIMIT_FALLBACK,
  RATE_LIMIT_FALLBACKS,
  type AvailabilityPolicy,
  type RateLimitFallback,
} from "./availability-policy";

export {
  consumeRateLimit,
  MAX_RATE_LIMIT,
  MAX_RATE_LIMIT_WINDOW_MS,
  MIN_RATE_LIMIT,
  MIN_RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_STATUS,
  type RateLimitIdentity,
  type RateLimitOptions,
  type RateLimitResult,
  type RateLimitStatus,
} from "./rate-limit.server";

export {
  abortIdempotency,
  beginIdempotency,
  completeIdempotency,
  idempotencyFingerprint,
  idempotencyKeyFor,
  isValidIdempotencyKey,
  DEFAULT_IDEMPOTENCY_COMPLETED_TTL_MS,
  DEFAULT_IDEMPOTENCY_PROCESSING_TTL_MS,
  IDEMPOTENCY_BEGIN_STATUS,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_SETTLE_STATUS,
  IDEMPOTENCY_STATE,
  MAX_IDEMPOTENCY_COMPLETED_TTL_MS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_IDEMPOTENCY_PAYLOAD_BYTES,
  MAX_IDEMPOTENCY_PROCESSING_TTL_MS,
  MIN_IDEMPOTENCY_COMPLETED_TTL_MS,
  MIN_IDEMPOTENCY_KEY_LENGTH,
  MIN_IDEMPOTENCY_PROCESSING_TTL_MS,
  type IdempotencyBeginOptions,
  type IdempotencyBeginResult,
  type IdempotencyBeginStatus,
  type IdempotencyHandle,
  type IdempotencyScope,
  type IdempotencySettleStatus,
  type IdempotencyState,
} from "./idempotency.server";

export {
  acquireLock,
  extendLock,
  lockKeyFor,
  releaseLock,
  withLock,
  DEFAULT_LOCK_RETRY_DELAY_MS,
  LOCK_STATUS,
  MAX_LOCK_LEASE_MS,
  MAX_LOCK_RETRY_DELAY_MS,
  MAX_LOCK_WAIT_TIMEOUT_MS,
  MIN_LOCK_LEASE_MS,
  MIN_LOCK_RETRY_DELAY_MS,
  WITH_LOCK_STATUS,
  type LockAcquisition,
  type LockHandle,
  type LockIdentity,
  type LockOptions,
  type LockStatus,
  type WithLockOptions,
  type WithLockResult,
  type WithLockStatus,
} from "./lock.server";

export {
  idempotencyLifecycle,
  rateLimitHook,
  readIdempotencyKey,
  type IdempotencyAdapterOptions,
  type RateLimitAdapterOptions,
  type RateLimitSubject,
} from "./route-adapters.server";

export {
  CONCURRENCY_LOG_EVENT,
  CONCURRENCY_OPERATION,
  type ConcurrencyLogEvent,
  type ConcurrencyOperation,
} from "./log-event";
