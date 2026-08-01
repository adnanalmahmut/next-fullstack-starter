import "server-only";

import { cacheLife, cacheTag as applyCacheTag } from "next/cache";

import { cacheTag, type CacheIdentity } from "./cache-identity";
import { CACHE_PROFILE, type CacheProfile } from "./cache-policy";

/**
 * The Next.js Cache Components side of caching.
 *
 * This is render and data acceleration, and it is a different thing from the
 * Redis cache-aside in this same directory. Next.js caches the *output* of a
 * function or component in its own store, keyed by the arguments; Redis caches a
 * *value* the application put there. They are invalidated by the same identity
 * but they are never one storage implementation, and no custom cache handler
 * makes Next.js write to Redis.
 *
 * The `"use cache"` directive is not wrapped by anything here. It cannot be:
 * Next.js resolves it statically at the call site, and hiding it behind a helper
 * would produce a function that looks cached and is not. A caller writes the
 * directive itself and calls `applyCachePolicy` inside the same function.
 */

/**
 * Declares the lifetime and the invalidation tags of the enclosing cached scope.
 *
 * It must be called *inside* a function or component that carries `"use cache"`,
 * in the same invocation, exactly once. Next.js resolves both APIs against the
 * cache scope that is currently open, so calling this at module scope, or from
 * an uncached function, throws.
 *
 *     export async function readUser(userId: string) {
 *       "use cache";
 *       applyCachePolicy(CACHE_PROFILE.STANDARD, userCache.detail(userId));
 *       return loadUser(userId);
 *     }
 *
 * The Next.js documentation suggests calling `cacheLife` directly at each call
 * site rather than through a helper. This helper exists anyway for one reason:
 * it is what makes the profile a member of a closed set. A direct call takes any
 * string, so a typo becomes a silent fallback to the default profile and an
 * arbitrary duration becomes possible; here the argument is a `CacheProfile` and
 * the tags are `CacheIdentity` values, so neither a duration nor a tag can be
 * invented at a call site. The directive itself stays visible and local.
 */
export function applyCachePolicy(
  profile: CacheProfile,
  ...identities: readonly CacheIdentity[]
): void {
  applyProfile(profile);
  applyCacheTags(...identities);
}

/**
 * Forwards the profile as a literal.
 *
 * Next.js generates one `cacheLife` overload per configured profile and drops
 * the generic `(profile: string)` one, so a union cannot be passed through:
 * TypeScript does not distribute a union argument across overloads. Writing the
 * switch is what turns that into an advantage — each branch names a literal that
 * must exist in the generated declarations, so deleting a profile from
 * `next.config.ts` fails the build here instead of silently falling back to the
 * default profile at runtime.
 *
 * The switch is exhaustive by construction: adding a profile without handling it
 * leaves a code path with no call and fails to compile.
 */
function applyProfile(profile: CacheProfile): void {
  switch (profile) {
    case CACHE_PROFILE.FREQUENT:
      cacheLife(CACHE_PROFILE.FREQUENT);

      return;
    case CACHE_PROFILE.STANDARD:
      cacheLife(CACHE_PROFILE.STANDARD);

      return;
    case CACHE_PROFILE.DURABLE:
      cacheLife(CACHE_PROFILE.DURABLE);

      return;
  }
}

/**
 * Tags the enclosing cached scope without choosing a lifetime.
 *
 * For a scope that has already declared its own `cacheLife`, or that
 * deliberately takes the Next.js default. Tagging is still required: an untagged
 * entry cannot be invalidated on demand and can only expire.
 */
export function applyCacheTags(...identities: readonly CacheIdentity[]): void {
  for (const identity of identities) {
    applyCacheTag(cacheTag(identity));
  }
}

/** The profile a caller should reach for when it has no reason to choose. */
export const DEFAULT_CACHE_PROFILE: CacheProfile = CACHE_PROFILE.STANDARD;
