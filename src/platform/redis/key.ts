import type { RedisNamespace } from "./namespace";

/**
 * The one place a Redis key is built.
 *
 * A key is not a string a call site composes; it is derived from a scope, a
 * namespace, and validated segments. That is what makes two features unable to
 * collide, and it is what makes a test run unable to touch another run's data.
 *
 * The shape is:
 *
 *     <prefix>:<environment>:<namespace>:<segments…>
 *
 * and under test, with a run identifier:
 *
 *     <prefix>:test:<run-id>:<worker-id>:<namespace>:<segments…>
 *
 * Environments are separated by prefix, never by Redis database number:
 * `SELECT` is not used anywhere, because a numbered database is invisible in a
 * key, silently shared by a connection, and unavailable in a cluster.
 */
export const REDIS_KEY_SEPARATOR = ":";

/** Where the keys of this process live. */
export type RedisKeyScope = Readonly<{
  prefix: string;
  environment: string;
  /** Present only under test, so one run cannot read or delete another's keys. */
  testRunId?: string;
  /** Present only under test, to separate parallel workers of one run. */
  testWorkerId?: string;
}>;

const MAX_SEGMENT_LENGTH = 128;

/**
 * A segment carries no separator, no whitespace, and no glob character.
 *
 * The separator would let a caller forge a key in another namespace, and a glob
 * character would make a key impossible to match safely with `SCAN`.
 */
const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

export function isValidRedisKeySegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_SEGMENT_LENGTH &&
    segmentPattern.test(value)
  );
}

/**
 * The scope prefix every key of this process shares.
 *
 * It is exported because a test cleanup needs exactly this string to bound its
 * `SCAN`, and deriving it twice would let the two drift apart.
 */
export function redisScopePrefix(scope: RedisKeyScope): string {
  const parts = [scope.prefix, scope.environment];

  if (scope.testRunId !== undefined) {
    parts.push(scope.testRunId);
  }

  if (scope.testWorkerId !== undefined) {
    parts.push(scope.testWorkerId);
  }

  for (const part of parts) {
    if (!isValidRedisKeySegment(part)) {
      throw new Error("The Redis key scope is not acceptable.");
    }
  }

  return parts.join(REDIS_KEY_SEPARATOR);
}

/**
 * Builds a fully qualified key.
 *
 * At least one segment is required: a key that is only a namespace would be the
 * namespace itself, and writing to it would make the namespace unusable.
 */
export function buildRedisKey(
  scope: RedisKeyScope,
  namespace: RedisNamespace,
  ...segments: readonly string[]
): string {
  if (segments.length === 0) {
    throw new Error("A Redis key requires at least one segment.");
  }

  for (const segment of segments) {
    if (!isValidRedisKeySegment(segment)) {
      throw new Error("The Redis key segment is not acceptable.");
    }
  }

  return [redisScopePrefix(scope), namespace, ...segments].join(
    REDIS_KEY_SEPARATOR,
  );
}

/**
 * The `SCAN` pattern for one namespace within this scope.
 *
 * The only place a `*` may appear is here, appended to an already-validated
 * prefix, so a pattern can never reach outside the scope that built it.
 */
export function redisNamespacePattern(
  scope: RedisKeyScope,
  namespace: RedisNamespace,
): string {
  return `${redisScopePrefix(scope)}${REDIS_KEY_SEPARATOR}${namespace}${REDIS_KEY_SEPARATOR}*`;
}

/** The `SCAN` pattern for every key in this scope. */
export function redisScopePattern(scope: RedisKeyScope): string {
  return `${redisScopePrefix(scope)}${REDIS_KEY_SEPARATOR}*`;
}
