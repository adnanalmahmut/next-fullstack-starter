import type { CacheIdentity } from "./cache-identity";
import { REVALIDATE_MAX_PROFILE } from "./cache-policy";

/**
 * What a mutation invalidates, declared as a value.
 *
 * The declaration is static and lives in the Action or Route definition, so a
 * path, a tag, or a Redis key can never be supplied by a caller: a client cannot
 * ask the server to purge an arbitrary route or another tenant's entry. Nothing
 * here derives a target from the input or from the use case output.
 *
 * Invalidation runs only after the use case has succeeded, and it is not
 * transactional with it. There is no transaction spanning PostgreSQL, Redis, and
 * the Next.js cache, and this module does not pretend otherwise: a completed
 * mutation must not be reported back as a retryable failure, so an invalidation
 * failure is recorded and the success result stands. The consequence is a window
 * of stale reads, bounded by the profile's `expire`, never a lost write.
 */
export const REVALIDATE_PATH_TYPE = {
  PAGE: "page",
  LAYOUT: "layout",
} as const;

export type RevalidatePathType =
  (typeof REVALIDATE_PATH_TYPE)[keyof typeof REVALIDATE_PATH_TYPE];

/**
 * A route file path to invalidate.
 *
 * `type` is required by Next.js when the path contains a dynamic segment such as
 * `/product/[slug]`, and must be omitted for a literal path.
 */
export type CachePathInvalidation = Readonly<{
  path: string;
  type?: RevalidatePathType;
}>;

/**
 * How a tag is invalidated.
 *
 * The two strategies are genuinely different promises to the user, not two ways
 * of writing the same thing:
 *
 * - `read-your-own-writes` expires the entry immediately, so the next read waits
 *   for fresh data. It is what a user who just saved something expects to see,
 *   and it costs a blocking revalidation.
 * - `stale-while-revalidate` marks the entry stale and serves the old value
 *   while a fresh one is produced in the background. It is right for data other
 *   people's requests display.
 *
 * `read-your-own-writes` is implemented with `updateTag`, which Next.js allows
 * only inside a Server Action. A Route Handler that declares it is refused where
 * it is declared rather than failing at request time.
 */
export const TAG_STRATEGY = {
  READ_YOUR_OWN_WRITES: "read-your-own-writes",
  STALE_WHILE_REVALIDATE: "stale-while-revalidate",
} as const;

export type TagStrategy = (typeof TAG_STRATEGY)[keyof typeof TAG_STRATEGY];

/**
 * The revalidation profile passed to `revalidateTag`.
 *
 * `"max"` is the recommended value and the default here. The deprecated
 * single-argument `revalidateTag(tag)` form is never used.
 */
export type RevalidateProfile = string | Readonly<{ expire?: number }>;

export const DEFAULT_REVALIDATE_PROFILE: RevalidateProfile =
  REVALIDATE_MAX_PROFILE;

/** A Next.js cache tag to invalidate, named by the identity that owns it. */
export type CacheTagInvalidation = Readonly<{
  identity: CacheIdentity;
  /** Defaults to `stale-while-revalidate`, the safe choice for a shared read. */
  strategy?: TagStrategy;
  /** Only meaningful for `stale-while-revalidate`. Defaults to `"max"`. */
  profile?: RevalidateProfile;
}>;

/**
 * A complete invalidation plan.
 *
 * `redis` names exact entries to delete. There is no wildcard and no pattern:
 * deleting by prefix would mean scanning a shared server on a mutation path, and
 * a mistaken prefix would erase another feature's cache. A caller that cannot
 * name the entries it invalidated should version the identity instead.
 */
export type CacheInvalidation = Readonly<{
  paths?: readonly CachePathInvalidation[];
  tags?: readonly CacheTagInvalidation[];
  redis?: readonly CacheIdentity[];
}>;

/** Where an invalidation plan is being run from. */
export const INVALIDATION_CONTEXT = {
  SERVER_ACTION: "server-action",
  ROUTE_HANDLER: "route-handler",
} as const;

export type InvalidationContext =
  (typeof INVALIDATION_CONTEXT)[keyof typeof INVALIDATION_CONTEXT];

export function hasCacheInvalidation(
  invalidation: CacheInvalidation | undefined,
): boolean {
  return Boolean(
    invalidation?.paths?.length ??
    invalidation?.tags?.length ??
    invalidation?.redis?.length,
  );
}

export function tagStrategyOf(tag: CacheTagInvalidation): TagStrategy {
  return tag.strategy ?? TAG_STRATEGY.STALE_WHILE_REVALIDATE;
}

/**
 * Refuses a plan a context cannot honour.
 *
 * `updateTag` is a Server Action API. A Route Handler declaring it would throw
 * inside the post-success step, where the mutation has already committed and the
 * failure can only be logged — so the check happens when the handler is defined,
 * at module load, where it is a startup error a test catches.
 */
export function assertInvalidationContext(
  invalidation: CacheInvalidation | undefined,
  context: InvalidationContext,
): void {
  if (context === INVALIDATION_CONTEXT.SERVER_ACTION) {
    return;
  }

  for (const tag of invalidation?.tags ?? []) {
    if (tagStrategyOf(tag) === TAG_STRATEGY.READ_YOUR_OWN_WRITES) {
      throw new Error(
        "The read-your-own-writes tag strategy is available only to a Server Action.",
      );
    }
  }
}
