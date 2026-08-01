import "server-only";

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
  opaqueKeySegment,
  REDIS_NAMESPACE,
} from "@/platform/redis/index.server";

import { CONCURRENCY_LOG_EVENT, CONCURRENCY_OPERATION } from "./log-event";
import {
  accessRedis,
  REDIS_ACCESS_STATUS,
  runRedisScript,
} from "./redis-access.server";

/**
 * A fixed-window rate limiter.
 *
 * The window is fixed rather than sliding because a fixed window is one counter
 * and one expiry, which is what makes it a single atomic script with no state to
 * reconcile. Its known cost is the boundary: a caller may spend its whole budget
 * at the end of one window and again at the start of the next, so the effective
 * short-term burst is up to twice the limit. That is an acceptable trade for a
 * protection layer, and it is the reason this is a limiter and not a quota.
 *
 * PostgreSQL is untouched here. A rate limit is not business state: losing the
 * counters costs a moment of unprotected traffic, never a lost write.
 */

/**
 * Increment and expiry in one server-side step.
 *
 * `INCRBY` followed by a separate `PEXPIRE` from the client has a real race: two
 * callers can both increment before either sets the expiry, and a crash between
 * the two leaves a counter that never resets and an endpoint that stays refused
 * forever. Inside a script the pair is atomic, and the `PTTL < 0` branch repairs
 * a key that somehow lost its expiry instead of trusting that it cannot happen.
 *
 * The reply is `{count, ttlMs}`. Nothing is computed in Lua that JavaScript can
 * compute, and no key is constructed here.
 */
const CONSUME_SCRIPT = `
local windowMs = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local count = redis.call('INCRBY', KEYS[1], cost)
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], windowMs)
  ttl = windowMs
end
return {count, ttl}
`;

export const MIN_RATE_LIMIT = 1;
export const MAX_RATE_LIMIT = 1_000_000;
export const MIN_RATE_LIMIT_WINDOW_MS = 100;
export const MAX_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1_000;

/**
 * Who is being limited, and by which limiter.
 *
 * `subject` is raw on the way in and hashed on the way into the key, so a call
 * site passes the natural value — an address, a user id, an API key — and cannot
 * accidentally publish it. It is never logged.
 */
export type RateLimitIdentity = Readonly<{
  /** The limiter's stable name, usually the route name it protects. */
  name: string;
  /** The caller being counted. Hashed before it becomes part of a key. */
  subject: string;
}>;

export type RateLimitOptions = Readonly<{
  identity: RateLimitIdentity;
  /** Units allowed per window. */
  limit: number;
  windowMs: number;
  /** Units this request costs. Defaults to one. */
  cost?: number;
}>;

export const RATE_LIMIT_STATUS = {
  ALLOWED: "allowed",
  LIMITED: "limited",
  DISABLED: "disabled",
  UNAVAILABLE: "unavailable",
} as const;

export type RateLimitStatus =
  (typeof RATE_LIMIT_STATUS)[keyof typeof RATE_LIMIT_STATUS];

/**
 * The limiter's answer.
 *
 * `disabled` and `unavailable` are separate members rather than an `allowed`
 * with a flag, so a caller cannot treat "no limiter ran" as "the limiter said
 * yes" by forgetting to check a boolean. Choosing what those two mean is the
 * caller's job, and the type makes the choice unavoidable.
 */
export type RateLimitResult =
  | Readonly<{
      status: typeof RATE_LIMIT_STATUS.ALLOWED;
      limit: number;
      remaining: number;
      resetAt: number;
    }>
  | Readonly<{
      status: typeof RATE_LIMIT_STATUS.LIMITED;
      limit: number;
      remaining: 0;
      resetAt: number;
      retryAfterMs: number;
    }>
  | Readonly<{ status: typeof RATE_LIMIT_STATUS.DISABLED }>
  | Readonly<{ status: typeof RATE_LIMIT_STATUS.UNAVAILABLE }>;

function assertOptions(options: RateLimitOptions, cost: number): void {
  if (
    !Number.isInteger(options.limit) ||
    options.limit < MIN_RATE_LIMIT ||
    options.limit > MAX_RATE_LIMIT
  ) {
    throw new Error("The rate limit is not acceptable.");
  }

  if (
    !Number.isInteger(options.windowMs) ||
    options.windowMs < MIN_RATE_LIMIT_WINDOW_MS ||
    options.windowMs > MAX_RATE_LIMIT_WINDOW_MS
  ) {
    throw new Error("The rate limit window is not acceptable.");
  }

  if (!Number.isInteger(cost) || cost < 1 || cost > options.limit) {
    throw new Error("The rate limit cost is not acceptable.");
  }

  if (!isValidRedisKeySegment(options.identity.name)) {
    throw new Error("The rate limit identity is not acceptable.");
  }

  if (
    typeof options.identity.subject !== "string" ||
    options.identity.subject.length === 0
  ) {
    throw new Error("The rate limit subject is not acceptable.");
  }
}

function rateLimitKey(identity: RateLimitIdentity): string {
  return buildRedisKey(
    getRedisKeyScope(),
    REDIS_NAMESPACE.RATE_LIMIT,
    identity.name,
    opaqueKeySegment(identity.subject),
  );
}

function log(
  event: string,
  outcome?: ControlOutcome,
  retryAfterMs?: number,
): void {
  const fields = toControlLogFields({
    module: CONTROL_MODULE.CONCURRENCY,
    operation: CONCURRENCY_OPERATION.RATE_LIMIT,
    ...(outcome === undefined ? {} : { outcome }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

  if (event === CONCURRENCY_LOG_EVENT.RATE_LIMIT_UNAVAILABLE) {
    getRequestLogger().warn(fields, event);

    return;
  }

  getRequestLogger().debug(fields, event);
}

/**
 * Reads the script's reply.
 *
 * A reply that is not the expected pair is treated as no answer at all rather
 * than coerced, because a limiter that silently reads `NaN` as zero would be a
 * limiter that stops limiting.
 */
function readReply(reply: unknown): { count: number; ttlMs: number } | null {
  if (!Array.isArray(reply) || reply.length < 2) {
    return null;
  }

  const count = Number(reply[0]);
  const ttlMs = Number(reply[1]);

  if (!Number.isFinite(count) || !Number.isFinite(ttlMs)) {
    return null;
  }

  return { count, ttlMs };
}

/**
 * Counts one request against a window.
 *
 * An over-limit request still increments. That is deliberate for a protection
 * layer: a client that keeps hammering a refused endpoint keeps its own window
 * full, so the refusal costs the server one `INCRBY` rather than a growing
 * queue of retries that reset the moment they stop.
 */
export async function consumeRateLimit(
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  const cost = options.cost ?? 1;

  assertOptions(options, cost);

  const access = await accessRedis();

  if (access.status === REDIS_ACCESS_STATUS.DISABLED) {
    log(CONCURRENCY_LOG_EVENT.RATE_LIMIT_UNAVAILABLE, CONTROL_OUTCOME.DISABLED);

    return { status: RATE_LIMIT_STATUS.DISABLED };
  }

  if (access.status === REDIS_ACCESS_STATUS.UNAVAILABLE) {
    log(
      CONCURRENCY_LOG_EVENT.RATE_LIMIT_UNAVAILABLE,
      CONTROL_OUTCOME.UNAVAILABLE,
    );

    return { status: RATE_LIMIT_STATUS.UNAVAILABLE };
  }

  let reply: unknown;

  try {
    reply = await runRedisScript(
      access.client,
      CONSUME_SCRIPT,
      [rateLimitKey(options.identity)],
      [String(options.windowMs), String(cost)],
    );
  } catch {
    log(
      CONCURRENCY_LOG_EVENT.RATE_LIMIT_UNAVAILABLE,
      CONTROL_OUTCOME.UNAVAILABLE,
    );

    return { status: RATE_LIMIT_STATUS.UNAVAILABLE };
  }

  const counted = readReply(reply);

  if (!counted) {
    log(
      CONCURRENCY_LOG_EVENT.RATE_LIMIT_UNAVAILABLE,
      CONTROL_OUTCOME.UNAVAILABLE,
    );

    return { status: RATE_LIMIT_STATUS.UNAVAILABLE };
  }

  const resetAt = Date.now() + counted.ttlMs;

  if (counted.count > options.limit) {
    log(CONCURRENCY_LOG_EVENT.RATE_LIMIT_REFUSED, undefined, counted.ttlMs);

    return {
      status: RATE_LIMIT_STATUS.LIMITED,
      limit: options.limit,
      remaining: 0,
      resetAt,
      retryAfterMs: counted.ttlMs,
    };
  }

  log(CONCURRENCY_LOG_EVENT.RATE_LIMIT_ALLOWED);

  return {
    status: RATE_LIMIT_STATUS.ALLOWED,
    limit: options.limit,
    remaining: Math.max(options.limit - counted.count, 0),
    resetAt,
  };
}
