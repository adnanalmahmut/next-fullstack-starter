import "server-only";

import {
  checkDatabaseHealth,
  DATABASE_HEALTH_STATUS,
  type DatabaseHealth,
} from "@/platform/database/index.server";
import {
  checkRedisHealth,
  REDIS_HEALTH_STATUS,
  type RedisHealth,
} from "@/platform/redis/index.server";
import {
  checkStorageHealth,
  STORAGE_HEALTH_STATUS,
  type StorageHealth,
} from "@/platform/storage/index.server";

import {
  DEPENDENCY_FAILURE_CODE,
  DEPENDENCY_NAME,
  DISABLED_DEPENDENCY,
  HEALTHY_DEPENDENCY,
  unhealthyDependency,
  type DependencyReport,
} from "./dependency-check";
import { HEALTH_CODE } from "./health-code";
import { createHealthRegistry, type HealthRegistry } from "./health-registry";

/**
 * What the web process checks, and what it deliberately does not.
 *
 * This is the composition root for web readiness: the one place the three
 * dependency checks a request-serving process has are named. Each check is owned
 * by the area it belongs to — this file adapts three area-specific results into
 * the one shape a probe response has, and holds no probe logic of its own.
 *
 * ## What is not checked, and why
 *
 * **The queue, the worker, and the outbox.** A web process can record work
 * without any of them: `writeOutboxMessage` is an insert inside the transaction
 * that earns it, so a request completes correctly with `JOBS_ENABLED=false`, with
 * no `JOBS_REDIS_URL`, and with no worker process anywhere. Checking the queue
 * here would make a web deployment unready because a *different* deployment is
 * down, and a load balancer would drain traffic from instances that were serving
 * perfectly. The worker has its own readiness contract for exactly this reason.
 *
 * **Better Auth, the cache, and the concurrency controls.** Authentication reads
 * the database this check already covers; the cache and the limiters run on the
 * Redis this check already covers, and each of them names its own fallback for a
 * Redis that will not answer. A separate probe would add a second opinion about
 * the same connection.
 *
 * ## Budgets
 *
 * Each dependency gets its own, because the calls are not comparable. A
 * `SELECT 1` on a warm pool answers in single-digit milliseconds; a `HeadBucket`
 * may cross a region. One shared number would either cut the object store off
 * during a normal slow moment or let it hold the probe open past the interval the
 * load balancer is calling on.
 */
export const WEB_READINESS_TIMEOUT_MS = {
  DATABASE: 2_000,
  REDIS: 1_500,
  STORAGE: 3_000,
} as const;

/**
 * PostgreSQL, which has no disabled state.
 *
 * Anything other than healthy is a failure: this is the one dependency the
 * application cannot serve a request without.
 */
export function toDatabaseReport(health: DatabaseHealth): DependencyReport {
  return health.status === DATABASE_HEALTH_STATUS.HEALTHY
    ? HEALTHY_DEPENDENCY
    : unhealthyDependency(DEPENDENCY_FAILURE_CODE.DATABASE);
}

/**
 * Redis, where `disabled` is a supported deployment and not a degradation.
 *
 * `REDIS_ENABLED=false` is answered from configuration by the Redis platform
 * itself: no client is constructed, no socket is opened, and no name is resolved.
 * This mapping just carries that through without turning it into a failure.
 */
export function toRedisReport(health: RedisHealth): DependencyReport {
  if (health.status === REDIS_HEALTH_STATUS.DISABLED) {
    return DISABLED_DEPENDENCY;
  }

  return health.status === REDIS_HEALTH_STATUS.HEALTHY
    ? HEALTHY_DEPENDENCY
    : unhealthyDependency(DEPENDENCY_FAILURE_CODE.REDIS);
}

/**
 * Object storage, whose two failure modes stay distinguishable.
 *
 * `unavailable` means it could not be reached and is worth retrying;
 * `misconfigured` means the provider answered and refused — a missing bucket,
 * rejected credentials, or variables that do not parse. Both make the process
 * unready, and collapsing them into one code would hide the difference between
 * "wait" and "someone has to deploy a fix" from whoever is reading the probe.
 *
 * Neither carries the bucket, the endpoint, or the provider's response. The
 * storage platform never returns those, and this mapping has nowhere to put them.
 */
export function toStorageReport(health: StorageHealth): DependencyReport {
  switch (health.status) {
    case STORAGE_HEALTH_STATUS.DISABLED:
      return DISABLED_DEPENDENCY;
    case STORAGE_HEALTH_STATUS.HEALTHY:
      return HEALTHY_DEPENDENCY;
    case STORAGE_HEALTH_STATUS.MISCONFIGURED:
      return unhealthyDependency(HEALTH_CODE.STORAGE_MISCONFIGURED);
    default:
      return unhealthyDependency(DEPENDENCY_FAILURE_CODE.STORAGE);
  }
}

/**
 * Builds the web registry.
 *
 * Called once, by the readiness route, at module load. It is a function rather
 * than a module-level constant so that nothing is constructed by the mere act of
 * importing this file, and so a test can build a fresh registry after changing
 * the environment.
 */
export function createWebReadinessRegistry(): HealthRegistry {
  return createHealthRegistry([
    {
      name: DEPENDENCY_NAME.DATABASE,
      timeoutMs: WEB_READINESS_TIMEOUT_MS.DATABASE,
      failureCode: DEPENDENCY_FAILURE_CODE.DATABASE,
      run: async () => toDatabaseReport(await checkDatabaseHealth()),
    },
    {
      name: DEPENDENCY_NAME.REDIS,
      timeoutMs: WEB_READINESS_TIMEOUT_MS.REDIS,
      failureCode: DEPENDENCY_FAILURE_CODE.REDIS,
      run: async () => toRedisReport(await checkRedisHealth()),
    },
    {
      name: DEPENDENCY_NAME.STORAGE,
      timeoutMs: WEB_READINESS_TIMEOUT_MS.STORAGE,
      failureCode: DEPENDENCY_FAILURE_CODE.STORAGE,
      run: async () => toStorageReport(await checkStorageHealth()),
    },
  ]);
}
