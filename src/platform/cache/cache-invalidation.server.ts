import "server-only";

import { revalidatePath, revalidateTag, updateTag } from "next/cache";

import {
  CONTROL_MODULE,
  toControlLogFields,
} from "@/platform/observability/control-log-fields";
import { getRequestLogger } from "@/platform/observability/logger.server";
import { toSafeLogError } from "@/platform/observability/safe-error";

import { cacheTag } from "./cache-identity";
import {
  DEFAULT_REVALIDATE_PROFILE,
  INVALIDATION_CONTEXT,
  TAG_STRATEGY,
  tagStrategyOf,
  type CacheInvalidation,
  type CacheTagInvalidation,
  type InvalidationContext,
} from "./cache-invalidation";
import { CACHE_LOG_EVENT, CACHE_OPERATION } from "./log-event";
import { invalidateRedisCache } from "./redis-cache-aside.server";

/**
 * Runs an invalidation plan across the three stores.
 *
 * The single most important property here is that one failure does not cancel
 * the rest. The mutation has already committed; the only question left is how
 * much of the world learns about it, and abandoning the remaining targets
 * because the first one failed would maximise the staleness rather than
 * minimise it. So each target is attempted independently, and the plan reports
 * what happened instead of throwing.
 *
 * This function never throws. Its caller is a post-success step in a factory,
 * and a completed mutation must not be turned into a response a client retries.
 */
export type CacheInvalidationReport = Readonly<{
  attempted: number;
  failed: number;
}>;

const EMPTY_REPORT: CacheInvalidationReport = { attempted: 0, failed: 0 };

function logInvalidationFailure(error: unknown): void {
  getRequestLogger().warn(
    toControlLogFields({
      module: CONTROL_MODULE.CACHE,
      operation: CACHE_OPERATION.INVALIDATION,
      errorCode: toSafeLogError(error).errorCode,
    }),
    CACHE_LOG_EVENT.INVALIDATION_FAILED,
  );
}

/**
 * Runs one target in isolation.
 *
 * The failure is reduced to a safe error code here, so a Next.js internal
 * message or a Redis error can never reach a log line through this path.
 */
async function attempt(run: () => void | Promise<void>): Promise<boolean> {
  try {
    await run();

    return true;
  } catch (error) {
    logInvalidationFailure(error);

    return false;
  }
}

function invalidateTag(
  tag: CacheTagInvalidation,
  context: InvalidationContext,
): void {
  const name = cacheTag(tag.identity);

  if (tagStrategyOf(tag) === TAG_STRATEGY.READ_YOUR_OWN_WRITES) {
    // Guarded rather than trusted: `assertInvalidationContext` refuses this at
    // definition time, and this second check means a plan built some other way
    // still cannot call a Server Action API from a Route Handler.
    if (context !== INVALIDATION_CONTEXT.SERVER_ACTION) {
      throw new Error(
        "The read-your-own-writes tag strategy is available only to a Server Action.",
      );
    }

    updateTag(name);

    return;
  }

  revalidateTag(name, tag.profile ?? DEFAULT_REVALIDATE_PROFILE);
}

/**
 * Applies a declaration to the Next.js cache and to Redis.
 *
 * The order is paths, then tags, then Redis. Next.js first because it is what a
 * user's next navigation reads; Redis last because a Redis round trip is the
 * only step here that can be slow, and the fast local invalidations should not
 * wait behind it.
 */
export async function runCacheInvalidation(
  invalidation: CacheInvalidation | undefined,
  context: InvalidationContext,
): Promise<CacheInvalidationReport> {
  if (!invalidation) {
    return EMPTY_REPORT;
  }

  let attempted = 0;
  let failed = 0;

  function record(succeeded: boolean): void {
    attempted += 1;

    if (!succeeded) {
      failed += 1;
    }
  }

  for (const { path, type } of invalidation.paths ?? []) {
    record(
      await attempt(() => {
        if (type === undefined) {
          revalidatePath(path);

          return;
        }

        revalidatePath(path, type);
      }),
    );
  }

  for (const tag of invalidation.tags ?? []) {
    record(await attempt(() => invalidateTag(tag, context)));
  }

  const redisIdentities = invalidation.redis ?? [];

  if (redisIdentities.length > 0) {
    record(
      await attempt(async () => {
        await invalidateRedisCache(redisIdentities);
      }),
    );
  }

  if (attempted > 0 && failed === 0) {
    getRequestLogger().debug(
      toControlLogFields({
        module: CONTROL_MODULE.CACHE,
        operation: CACHE_OPERATION.INVALIDATION,
      }),
      CACHE_LOG_EVENT.INVALIDATED,
    );
  }

  return { attempted, failed };
}
