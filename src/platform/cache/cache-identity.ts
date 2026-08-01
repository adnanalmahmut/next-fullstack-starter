import { opaqueKeySegment } from "@/platform/redis/index.server";

/**
 * What a cached thing *is*, as a value rather than a string.
 *
 * A raw string key is the usual way caching goes wrong: two features invent the
 * same key and read each other's data, a stale schema is served after a shape
 * change because nothing in the key said which shape it was, and a user
 * identifier ends up printed in a log line or a cache tag. An identity closes
 * all three. It is validated, it carries a version, and it is the only thing the
 * cache APIs in this directory accept.
 *
 * The same identity produces both a Next.js cache tag and a Redis key, so one
 * declaration invalidates both stores and the two can never drift apart.
 *
 * Identities are built by the module that owns the data, never by this
 * directory: `module` and `resource` are business vocabulary, and a platform
 * that named them would have to be edited every time a feature is added.
 */
export type CacheIdentity = Readonly<{
  /** The owning module, such as `identity` or `catalog`. */
  module: string;
  /** The thing being cached within that module, such as `user`. */
  resource: string;
  /**
   * The shape version.
   *
   * Increment it when the cached value's shape changes. Old entries then become
   * unreachable rather than being decoded as the new shape, which is the
   * difference between a deploy that warms a cold cache and a deploy that reads
   * yesterday's fields into today's type.
   */
  version: number;
  /** What distinguishes one entry from another. Empty means the collection. */
  segments: readonly string[];
}>;

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_NAME_LENGTH = 32;

/**
 * Segments share the Redis key contract: no separator, no whitespace, no glob
 * character. A separator would let a caller forge an identity in another
 * module's space, and a glob character would make a key unsafe to match.
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const MAX_SEGMENT_LENGTH = 128;
const MAX_SEGMENT_COUNT = 8;

const MAX_VERSION = 999;

/** Next.js drops a tag longer than this, silently as far as a caller can tell. */
export const MAX_CACHE_TAG_LENGTH = 256;

export const CACHE_TAG_SEPARATOR = ":";

function isValidName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_NAME_LENGTH &&
    NAME_PATTERN.test(value)
  );
}

export function isValidCacheSegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_SEGMENT_LENGTH &&
    SEGMENT_PATTERN.test(value)
  );
}

/**
 * Turns a sensitive value into a cache segment that discloses nothing.
 *
 * A cache tag is not private: it appears in traces and in invalidation calls,
 * and the Redis key derived from the same identity is readable by anyone with
 * access to the server. An email address, an IP address, a session id, a token,
 * or an idempotency key is therefore hashed before it can become a segment.
 *
 * The implementation is the Redis key module's, so a value hashed for a tag and
 * the same value hashed for a key produce the same segment.
 */
export const opaqueCacheSegment = opaqueKeySegment;

/**
 * Builds a validated identity.
 *
 * Every rule is enforced here, once, so a module's key factory is a one-line
 * declaration and cannot forget one of them. The refusal message names the part
 * that was wrong and never the value, which may itself be the sensitive thing.
 */
export function createCacheIdentity(
  identity: CacheIdentity,
): Readonly<CacheIdentity> {
  if (!isValidName(identity.module)) {
    throw new Error("The cache identity module is not acceptable.");
  }

  if (!isValidName(identity.resource)) {
    throw new Error("The cache identity resource is not acceptable.");
  }

  if (
    !Number.isInteger(identity.version) ||
    identity.version < 1 ||
    identity.version > MAX_VERSION
  ) {
    throw new Error("The cache identity version is not acceptable.");
  }

  if (identity.segments.length > MAX_SEGMENT_COUNT) {
    throw new Error("The cache identity carries too many segments.");
  }

  for (const segment of identity.segments) {
    if (!isValidCacheSegment(segment)) {
      throw new Error("The cache identity segment is not acceptable.");
    }
  }

  const resolved: CacheIdentity = {
    module: identity.module,
    resource: identity.resource,
    version: identity.version,
    segments: Object.freeze([...identity.segments]),
  };

  // Built once here so an identity that cannot produce a usable tag is refused
  // where it is declared, rather than silently dropped by Next.js at read time.
  if (cacheTag(resolved).length > MAX_CACHE_TAG_LENGTH) {
    throw new Error("The cache identity produces a tag that is too long.");
  }

  return Object.freeze(resolved);
}

/** The version part of a key or tag, kept identical in both. */
export function cacheVersionSegment(version: number): string {
  return `v${version}`;
}

/**
 * The Next.js cache tag for an identity.
 *
 * The shape is `module:resource:vN[:segment…]`, so the collection tag is a
 * prefix of every entry tag and a reader can tell at a glance what a tag refers
 * to. Nothing outside this file builds a tag string.
 */
export function cacheTag(identity: CacheIdentity): string {
  return [
    identity.module,
    identity.resource,
    cacheVersionSegment(identity.version),
    ...identity.segments,
  ].join(CACHE_TAG_SEPARATOR);
}

/**
 * The identity's parts as Redis key segments.
 *
 * The Redis scope, namespace, and separator are added by the Redis key builder;
 * this only supplies the parts the identity owns, so the two key spaces stay
 * derived from one declaration.
 */
export function cacheKeySegments(identity: CacheIdentity): readonly string[] {
  return [
    identity.module,
    identity.resource,
    cacheVersionSegment(identity.version),
    ...identity.segments,
  ];
}

/** The collection identity an entry belongs to: the same identity, no segments. */
export function cacheCollectionIdentity(
  identity: CacheIdentity,
): Readonly<CacheIdentity> {
  return createCacheIdentity({
    module: identity.module,
    resource: identity.resource,
    version: identity.version,
    segments: [],
  });
}
