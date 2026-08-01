/**
 * The closed set of cache-life profiles.
 *
 * A profile is named here and configured once in `next.config.ts`. A module
 * chooses a name from this set and never writes a duration of its own, so the
 * question "how long is this cached for?" has three possible answers across the
 * whole application instead of one per call site.
 *
 * The three durations mean different things and are easy to confuse:
 *
 * - `stale` is how long a client may reuse its copy without asking the server.
 * - `revalidate` is how often the server refreshes in the background.
 * - `expire` is how long a value may be served stale before a request has to
 *   wait for a fresh one.
 *
 * `expire` must therefore exceed `revalidate`; a profile that expires before it
 * revalidates would turn every refresh into a blocking miss. The invariant is
 * asserted below rather than left to review.
 */
export const CACHE_PROFILE = {
  /** Data that changes constantly and is cheap to recompute. */
  FREQUENT: "frequent",
  /** The default choice: data that changes during a working session. */
  STANDARD: "standard",
  /** Data that changes rarely, such as a catalogue or a settings document. */
  DURABLE: "durable",
} as const;

export type CacheProfile = (typeof CACHE_PROFILE)[keyof typeof CACHE_PROFILE];

export const CACHE_PROFILES: readonly CacheProfile[] =
  Object.values(CACHE_PROFILE);

export type CacheProfileDefinition = Readonly<{
  /** Seconds a client may serve its own copy without revalidating. */
  stale: number;
  /** Seconds after which the server refreshes in the background. */
  revalidate: number;
  /** Seconds after which a stale value may no longer be served. */
  expire: number;
}>;

/**
 * The single source of the profile durations.
 *
 * `next.config.ts` builds its `cacheLife` configuration from this object, so the
 * runtime profile and the profile a module names cannot drift apart.
 */
export const CACHE_PROFILE_DEFINITIONS = {
  [CACHE_PROFILE.FREQUENT]: { stale: 30, revalidate: 30, expire: 300 },
  [CACHE_PROFILE.STANDARD]: { stale: 300, revalidate: 300, expire: 3_600 },
  [CACHE_PROFILE.DURABLE]: { stale: 3_600, revalidate: 3_600, expire: 86_400 },
} as const satisfies Record<CacheProfile, CacheProfileDefinition>;

export function isCacheProfile(value: unknown): value is CacheProfile {
  return (
    typeof value === "string" &&
    (CACHE_PROFILES as readonly string[]).includes(value)
  );
}

/**
 * The profile the on-demand invalidation APIs are given.
 *
 * `"max"` is a Next.js built-in, not one of the profiles above: it marks a tag
 * stale and serves stale-while-revalidate while a fresh value is produced. The
 * deprecated single-argument `revalidateTag(tag)` form is never used anywhere in
 * this repository, so the pinned two-argument signature always holds.
 */
export const REVALIDATE_MAX_PROFILE = "max" as const;

/**
 * Checks the invariant every profile has to satisfy.
 *
 * Exported so a unit test asserts it against the real definitions rather than
 * against a copy, and so a future profile cannot be added without satisfying it.
 */
export function isValidCacheProfileDefinition(
  definition: CacheProfileDefinition,
): boolean {
  return (
    Number.isInteger(definition.stale) &&
    Number.isInteger(definition.revalidate) &&
    Number.isInteger(definition.expire) &&
    definition.stale > 0 &&
    definition.revalidate > 0 &&
    definition.expire > definition.revalidate
  );
}
