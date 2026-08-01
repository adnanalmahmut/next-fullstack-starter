import "server-only";

import { revalidatePath, revalidateTag } from "next/cache";

/**
 * Declarative cache invalidation for a Server Action.
 *
 * The declaration is static and lives in the Action definition, so a path or a
 * tag can never be supplied by a caller: a client cannot ask the server to purge
 * an arbitrary route or an unrelated tenant's tag. Nothing here derives a path
 * from the input or from the use case output.
 *
 * Invalidation runs only after the use case has succeeded, and it is not
 * transactional with it. A completed mutation must not be reported back as a
 * retryable failure, so an invalidation failure is recorded and the success
 * result stands; the consequence is a window of stale reads, never a lost write.
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
 * The recommended revalidation profile.
 *
 * `"max"` marks the tag stale and serves stale-while-revalidate. The deprecated
 * single-argument `revalidateTag(tag)` form is never used: this module always
 * passes a profile, so the pinned two-argument signature is satisfied.
 */
export const DEFAULT_REVALIDATE_PROFILE = "max";

export type RevalidateProfile = string | Readonly<{ expire?: number }>;

/** A cache tag to invalidate, with the profile that decides the semantics. */
export type CacheTagInvalidation = Readonly<{
  tag: string;
  profile?: RevalidateProfile;
}>;

export type CacheInvalidation = Readonly<{
  paths?: readonly CachePathInvalidation[];
  tags?: readonly CacheTagInvalidation[];
}>;

export function hasCacheInvalidation(
  invalidation: CacheInvalidation | undefined,
): boolean {
  return Boolean(invalidation?.paths?.length ?? invalidation?.tags?.length);
}

/**
 * Applies a declaration through the Next.js cache APIs.
 *
 * Paths run before tags, in declaration order. A failure propagates to the
 * caller, which is the factory's post-success step: it is the single place that
 * decides a post-success failure is logged rather than returned.
 */
export function runCacheInvalidation(
  invalidation: CacheInvalidation | undefined,
): void {
  if (!invalidation) {
    return;
  }

  for (const { path, type } of invalidation.paths ?? []) {
    if (type === undefined) {
      revalidatePath(path);
      continue;
    }

    revalidatePath(path, type);
  }

  for (const { tag, profile } of invalidation.tags ?? []) {
    revalidateTag(tag, profile ?? DEFAULT_REVALIDATE_PROFILE);
  }
}
