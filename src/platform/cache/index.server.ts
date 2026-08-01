import "server-only";

/**
 * The controlled server-only entry point for caching.
 *
 * Two stores live behind it and they stay distinct: Next.js Cache Components
 * accelerate rendering and data, and Redis cache-aside holds values the
 * application put there. Neither is a source of truth, and no custom Next.js
 * cache handler makes one write into the other.
 *
 * The declaration types stay importable on their own from `cache-identity.ts`,
 * `cache-policy.ts`, and `cache-invalidation.ts`, so a module that only declares
 * a key factory does not pull the Redis client in with it.
 */
export {
  cacheCollectionIdentity,
  cacheKeySegments,
  cacheTag,
  cacheVersionSegment,
  createCacheIdentity,
  isValidCacheSegment,
  opaqueCacheSegment,
  CACHE_TAG_SEPARATOR,
  MAX_CACHE_TAG_LENGTH,
  type CacheIdentity,
} from "./cache-identity";

export {
  isCacheProfile,
  isValidCacheProfileDefinition,
  CACHE_PROFILE,
  CACHE_PROFILE_DEFINITIONS,
  CACHE_PROFILES,
  REVALIDATE_MAX_PROFILE,
  type CacheProfile,
  type CacheProfileDefinition,
} from "./cache-policy";

export {
  applyCachePolicy,
  applyCacheTags,
  DEFAULT_CACHE_PROFILE,
} from "./next-cache.server";

export {
  assertInvalidationContext,
  hasCacheInvalidation,
  tagStrategyOf,
  DEFAULT_REVALIDATE_PROFILE,
  INVALIDATION_CONTEXT,
  REVALIDATE_PATH_TYPE,
  TAG_STRATEGY,
  type CacheInvalidation,
  type CachePathInvalidation,
  type CacheTagInvalidation,
  type InvalidationContext,
  type RevalidatePathType,
  type RevalidateProfile,
  type TagStrategy,
} from "./cache-invalidation";

export {
  runCacheInvalidation,
  type CacheInvalidationReport,
} from "./cache-invalidation.server";

export {
  cacheAside,
  invalidateRedisCache,
  jitteredTtlMs,
  redisCacheKey,
  MAX_CACHE_TTL_JITTER_RATIO,
  MAX_CACHE_TTL_MS,
  MAX_CACHE_VALUE_BYTES,
  MIN_CACHE_TTL_MS,
  type CacheAsideOptions,
} from "./redis-cache-aside.server";

export {
  CACHE_LOG_EVENT,
  CACHE_OPERATION,
  type CacheLogEvent,
  type CacheOperation,
} from "./log-event";
