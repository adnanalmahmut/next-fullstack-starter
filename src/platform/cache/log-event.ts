/**
 * Stable log event names for the cache boundary.
 *
 * They are language-neutral identifiers, not user-facing text. The fields a
 * cache line may carry are the shared control allowlist and nothing else: never
 * a Redis key, a cache tag, a cached value, a loaded value, an input, or a raw
 * error.
 *
 * A hit is `debug` rather than `info` on purpose. A cache that works produces
 * one line per read, which at `info` would drown every other line in the
 * request; the events worth an operator's attention are the ones that say the
 * cache is not doing its job.
 */
export const CACHE_LOG_EVENT = {
  HIT: "cache.hit",
  MISS: "cache.miss",
  BYPASSED: "cache.bypassed",
  WRITE_FAILED: "cache.write_failed",
  INVALIDATED: "cache.invalidated",
  INVALIDATION_FAILED: "cache.invalidation_failed",
} as const;

export type CacheLogEvent =
  (typeof CACHE_LOG_EVENT)[keyof typeof CACHE_LOG_EVENT];

/** The operations a cache log line can be attributed to. */
export const CACHE_OPERATION = {
  ASIDE: "cache-aside",
  INVALIDATION: "cache-invalidation",
} as const;

export type CacheOperation =
  (typeof CACHE_OPERATION)[keyof typeof CACHE_OPERATION];
