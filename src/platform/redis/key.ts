import { createHash } from "node:crypto";

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
 * The length of an opaque segment.
 *
 * 32 hexadecimal characters is 128 bits of a SHA-256 digest: far beyond any
 * collision that matters for a key, and short enough that several of them fit
 * inside one key or one cache tag.
 */
const OPAQUE_SEGMENT_LENGTH = 32;

/**
 * Turns a sensitive value into a segment that discloses nothing.
 *
 * An email address, an IP address, a session id, a token, or an idempotency key
 * must never appear in a key: keys are readable by anyone with access to the
 * server, and they surface in traces and in `SCAN` output. Hashing keeps the
 * only property a key needs — the same input yields the same segment — while
 * making the segment useless to a reader.
 *
 * This is not a password hash and must not be used as one. It is unsalted, which
 * is deliberate: a key has to be derivable by every process, so a per-process
 * salt would make the same subject produce a different key on every server.
 */
export function opaqueKeySegment(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("An opaque key segment requires a non-empty value.");
  }

  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex")
    .slice(0, OPAQUE_SEGMENT_LENGTH);
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
