import "server-only";

import { randomBytes, randomInt } from "node:crypto";

import {
  CONTROL_MODULE,
  CONTROL_OUTCOME,
  toControlLogFields,
  type ControlOutcome,
} from "@/platform/observability/control-log-fields";
import { getRequestLogger } from "@/platform/observability/logger.server";
import {
  buildRedisKey,
  getRedisKeyScope,
  isValidRedisKeySegment,
  REDIS_NAMESPACE,
} from "@/platform/redis/index.server";
import { DependencyUnavailableError } from "@/shared/errors/application-error";

import {
  AVAILABILITY_POLICY,
  type AvailabilityPolicy,
} from "./availability-policy";
import { CONCURRENCY_LOG_EVENT, CONCURRENCY_OPERATION } from "./log-event";
import {
  accessRedis,
  REDIS_ACCESS_STATUS,
  runRedisScript,
} from "./redis-access.server";

/**
 * A single-Redis lease lock.
 *
 * What it is: a way for several instances of this application to avoid doing the
 * same avoidable work at the same time — one instance rebuilding a report, one
 * instance draining a queue, one instance sending a digest.
 *
 * What it is not, and must never be relied on as:
 *
 * - It is not a substitute for a database constraint or a transaction. A unique
 *   index refuses a duplicate no matter what the application believed; a lock
 *   only refuses the callers that asked it.
 * - It does not protect a financial invariant on its own. If correctness depends
 *   on an operation happening once, that has to be enforced where the data is,
 *   inside the transaction that writes it.
 * - It is not Redlock. There is one Redis, so a failover that loses recent
 *   writes can hand the same lease to two owners, and no amount of client-side
 *   care changes that.
 * - It is bounded by the lease, not by the callback. Work that outlives its
 *   lease is no longer protected, and the next caller is entitled to the lock.
 *
 * Everything below follows from taking those limits seriously: the lease always
 * has a TTL, the waiting is always bounded, and a release only ever removes the
 * caller's own lease.
 */

/**
 * Release, but only if this caller still owns the lease.
 *
 * A plain `DEL` is the classic distributed-lock bug: a caller whose lease
 * expired mid-work deletes the key that now belongs to somebody else, and two
 * callers proceed at once. Comparing the token and deleting in one script closes
 * that window entirely.
 */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('UNLINK', KEYS[1])
end
return 0
`;

/** Extend, with the same ownership check for the same reason. */
const EXTEND_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 0
`;

export const MIN_LOCK_LEASE_MS = 100;
export const MAX_LOCK_LEASE_MS = 5 * 60 * 1_000;
export const MAX_LOCK_WAIT_TIMEOUT_MS = 30_000;
export const MIN_LOCK_RETRY_DELAY_MS = 5;
export const MAX_LOCK_RETRY_DELAY_MS = 1_000;
export const DEFAULT_LOCK_RETRY_DELAY_MS = 50;

const LOCK_TOKEN_BYTES = 16;

/** What is being locked. `segments` distinguish one instance of it from another. */
export type LockIdentity = Readonly<{
  name: string;
  segments?: readonly string[];
}>;

export const LOCK_STATUS = {
  ACQUIRED: "acquired",
  /** Someone else holds it, and this caller chose not to wait. */
  CONTENDED: "contended",
  /** Someone else held it for the whole time this caller was willing to wait. */
  TIMEOUT: "timeout",
  DISABLED: "disabled",
  UNAVAILABLE: "unavailable",
} as const;

export type LockStatus = (typeof LOCK_STATUS)[keyof typeof LOCK_STATUS];

export type LockHandle = Readonly<{
  key: string;
  token: string;
  leaseMs: number;
}>;

export type LockAcquisition =
  | Readonly<{ status: typeof LOCK_STATUS.ACQUIRED; handle: LockHandle }>
  | Readonly<{ status: typeof LOCK_STATUS.CONTENDED }>
  | Readonly<{ status: typeof LOCK_STATUS.TIMEOUT }>
  | Readonly<{ status: typeof LOCK_STATUS.DISABLED }>
  | Readonly<{ status: typeof LOCK_STATUS.UNAVAILABLE }>;

export type LockOptions = Readonly<{
  identity: LockIdentity;
  /** How long the lease lasts. Work must fit inside it or lose its protection. */
  leaseMs: number;
  /** How long to keep trying. Zero means a single attempt. */
  waitTimeoutMs?: number;
  retryDelayMs?: number;
}>;

function assertOptions(
  options: LockOptions,
  waitTimeoutMs: number,
  retryDelayMs: number,
): void {
  if (
    !Number.isInteger(options.leaseMs) ||
    options.leaseMs < MIN_LOCK_LEASE_MS ||
    options.leaseMs > MAX_LOCK_LEASE_MS
  ) {
    throw new Error("The lock lease is not acceptable.");
  }

  if (
    !Number.isInteger(waitTimeoutMs) ||
    waitTimeoutMs < 0 ||
    waitTimeoutMs > MAX_LOCK_WAIT_TIMEOUT_MS
  ) {
    throw new Error("The lock wait timeout is not acceptable.");
  }

  if (
    !Number.isInteger(retryDelayMs) ||
    retryDelayMs < MIN_LOCK_RETRY_DELAY_MS ||
    retryDelayMs > MAX_LOCK_RETRY_DELAY_MS
  ) {
    throw new Error("The lock retry delay is not acceptable.");
  }

  if (!isValidRedisKeySegment(options.identity.name)) {
    throw new Error("The lock identity is not acceptable.");
  }

  for (const segment of options.identity.segments ?? []) {
    if (!isValidRedisKeySegment(segment)) {
      throw new Error("The lock identity segment is not acceptable.");
    }
  }
}

export function lockKeyFor(identity: LockIdentity): string {
  return buildRedisKey(
    getRedisKeyScope(),
    REDIS_NAMESPACE.LOCK,
    identity.name,
    ...(identity.segments ?? []),
  );
}

function log(event: string, outcome?: ControlOutcome): void {
  const fields = toControlLogFields({
    module: CONTROL_MODULE.CONCURRENCY,
    operation: CONCURRENCY_OPERATION.LOCK,
    ...(outcome === undefined ? {} : { outcome }),
  });

  if (
    event === CONCURRENCY_LOG_EVENT.LOCK_UNAVAILABLE ||
    event === CONCURRENCY_LOG_EVENT.LOCK_RELEASE_FAILED
  ) {
    getRequestLogger().warn(fields, event);

    return;
  }

  getRequestLogger().debug(fields, event);
}

/**
 * Waits before the next attempt.
 *
 * The jitter is what stops a queue of waiters from retrying in lockstep and
 * colliding on every round. `randomInt` rather than `Math.random` because the
 * same helper already needs a cryptographic source for the token, and using one
 * source removes the question of which calls need which.
 */
function nextDelayMs(retryDelayMs: number): number {
  return retryDelayMs + randomInt(0, Math.floor(retryDelayMs / 2) + 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Takes the lock, waiting no longer than it was told to.
 *
 * The loop is bounded by a deadline computed once, so it terminates whether the
 * lock is busy, the clock jumps, or Redis is slow. A caller that passes no wait
 * timeout makes exactly one attempt.
 */
export async function acquireLock(
  options: LockOptions,
): Promise<LockAcquisition> {
  const waitTimeoutMs = options.waitTimeoutMs ?? 0;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;

  assertOptions(options, waitTimeoutMs, retryDelayMs);

  const access = await accessRedis();

  if (access.status === REDIS_ACCESS_STATUS.DISABLED) {
    log(CONCURRENCY_LOG_EVENT.LOCK_UNAVAILABLE, CONTROL_OUTCOME.DISABLED);

    return { status: LOCK_STATUS.DISABLED };
  }

  if (access.status === REDIS_ACCESS_STATUS.UNAVAILABLE) {
    log(CONCURRENCY_LOG_EVENT.LOCK_UNAVAILABLE, CONTROL_OUTCOME.UNAVAILABLE);

    return { status: LOCK_STATUS.UNAVAILABLE };
  }

  const key = lockKeyFor(options.identity);
  const token = randomBytes(LOCK_TOKEN_BYTES).toString("hex");
  const deadline = Date.now() + waitTimeoutMs;

  let waited = false;

  for (;;) {
    let taken: unknown;

    try {
      taken = await access.client.set(key, token, {
        condition: "NX",
        expiration: { type: "PX", value: options.leaseMs },
      });
    } catch {
      log(CONCURRENCY_LOG_EVENT.LOCK_UNAVAILABLE, CONTROL_OUTCOME.UNAVAILABLE);

      return { status: LOCK_STATUS.UNAVAILABLE };
    }

    if (taken !== null) {
      log(CONCURRENCY_LOG_EVENT.LOCK_ACQUIRED);

      return {
        status: LOCK_STATUS.ACQUIRED,
        handle: { key, token, leaseMs: options.leaseMs },
      };
    }

    const delayMs = nextDelayMs(retryDelayMs);

    if (Date.now() + delayMs > deadline) {
      // Reported as contention when the caller never intended to wait, and as a
      // timeout when it did: the first is a normal outcome, the second is a
      // symptom worth watching.
      if (waited) {
        log(CONCURRENCY_LOG_EVENT.LOCK_TIMEOUT);

        return { status: LOCK_STATUS.TIMEOUT };
      }

      log(CONCURRENCY_LOG_EVENT.LOCK_CONTENDED);

      return { status: LOCK_STATUS.CONTENDED };
    }

    waited = true;
    await sleep(delayMs);
  }
}

/**
 * Releases a lease this caller owns.
 *
 * Answers whether the lease was still the caller's. `false` is not an error: it
 * means the lease expired and somebody else may already be working, which is
 * exactly what the caller needs to know.
 */
export async function releaseLock(handle: LockHandle): Promise<boolean> {
  const access = await accessRedis();

  if (access.status !== REDIS_ACCESS_STATUS.READY) {
    log(CONCURRENCY_LOG_EVENT.LOCK_RELEASE_FAILED, CONTROL_OUTCOME.UNAVAILABLE);

    return false;
  }

  try {
    const removed = await runRedisScript(
      access.client,
      RELEASE_SCRIPT,
      [handle.key],
      [handle.token],
    );

    if (Number(removed) === 1) {
      log(CONCURRENCY_LOG_EVENT.LOCK_RELEASED);

      return true;
    }

    log(CONCURRENCY_LOG_EVENT.LOCK_RELEASE_FAILED, CONTROL_OUTCOME.EXPIRED);

    return false;
  } catch {
    log(CONCURRENCY_LOG_EVENT.LOCK_RELEASE_FAILED, CONTROL_OUTCOME.UNAVAILABLE);

    return false;
  }
}

/**
 * Extends a lease this caller owns.
 *
 * Only useful for work whose duration is genuinely unpredictable, and only safe
 * because the ownership check is inside the script: extending a lease somebody
 * else now holds would be worse than losing it.
 */
export async function extendLock(
  handle: LockHandle,
  leaseMs: number,
): Promise<boolean> {
  if (
    !Number.isInteger(leaseMs) ||
    leaseMs < MIN_LOCK_LEASE_MS ||
    leaseMs > MAX_LOCK_LEASE_MS
  ) {
    throw new Error("The lock lease is not acceptable.");
  }

  const access = await accessRedis();

  if (access.status !== REDIS_ACCESS_STATUS.READY) {
    return false;
  }

  try {
    const extended = await runRedisScript(
      access.client,
      EXTEND_SCRIPT,
      [handle.key],
      [handle.token, String(leaseMs)],
    );

    return Number(extended) === 1;
  } catch {
    return false;
  }
}

export const WITH_LOCK_STATUS = {
  EXECUTED: "executed",
  CONTENDED: "contended",
  TIMEOUT: "timeout",
} as const;

export type WithLockStatus =
  (typeof WITH_LOCK_STATUS)[keyof typeof WITH_LOCK_STATUS];

export type WithLockResult<TValue> =
  | Readonly<{ status: typeof WITH_LOCK_STATUS.EXECUTED; value: TValue }>
  | Readonly<{ status: typeof WITH_LOCK_STATUS.CONTENDED }>
  | Readonly<{ status: typeof WITH_LOCK_STATUS.TIMEOUT }>;

export type WithLockOptions = LockOptions &
  Readonly<{
    /**
     * What to do when Redis is disabled or unreachable.
     *
     * There is no default. `required` refuses with `DEPENDENCY_UNAVAILABLE`;
     * `best-effort` runs the callback unprotected and records the degradation.
     */
    policy: AvailabilityPolicy;
  }>;

/**
 * Runs a callback under a lock.
 *
 * The callback runs at most once in every path — contention returns before it,
 * and a release failure happens after it — and the release is in `finally`, so a
 * throwing callback still gives the lease back instead of holding it until it
 * expires. A release failure is recorded and never replaces the callback's own
 * error, because the caller needs to see what actually went wrong.
 */
export async function withLock<TValue>(
  options: WithLockOptions,
  callback: () => TValue | Promise<TValue>,
): Promise<WithLockResult<TValue>> {
  const acquisition = await acquireLock(options);

  if (
    acquisition.status === LOCK_STATUS.DISABLED ||
    acquisition.status === LOCK_STATUS.UNAVAILABLE
  ) {
    if (options.policy === AVAILABILITY_POLICY.REQUIRED) {
      throw new DependencyUnavailableError(
        "The coordination lock is unavailable.",
      );
    }

    log(CONCURRENCY_LOG_EVENT.LOCK_UNAVAILABLE, CONTROL_OUTCOME.DEGRADED);

    return { status: WITH_LOCK_STATUS.EXECUTED, value: await callback() };
  }

  if (acquisition.status === LOCK_STATUS.CONTENDED) {
    return { status: WITH_LOCK_STATUS.CONTENDED };
  }

  if (acquisition.status === LOCK_STATUS.TIMEOUT) {
    return { status: WITH_LOCK_STATUS.TIMEOUT };
  }

  try {
    return {
      status: WITH_LOCK_STATUS.EXECUTED,
      value: await callback(),
    };
  } finally {
    await releaseLock(acquisition.handle);
  }
}
