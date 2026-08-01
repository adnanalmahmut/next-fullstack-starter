import "server-only";

import { startOperationTimer } from "@/platform/observability/operation-timer.server";

import { getRedisClient } from "./client.server";
import { getRedisConfiguration } from "./config";

/**
 * The Redis health contract.
 *
 * Three outcomes, and the distinction between the first two matters: a disabled
 * Redis is a deployment choice and must never make an application look
 * unhealthy, while an enabled Redis that will not answer is a real fault.
 *
 * `unhealthy` carries a stable code and nothing else. A health result is the
 * most likely thing in a system to be rendered on a page or shipped to a status
 * dashboard, so it is exactly where a raw driver message or a connection string
 * must not be able to reach.
 */
export type RedisHealth =
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "healthy"; latencyMs: number }>
  | Readonly<{ status: "unhealthy"; code: "REDIS_UNAVAILABLE" }>;

export const REDIS_HEALTH_STATUS = {
  DISABLED: "disabled",
  HEALTHY: "healthy",
  UNHEALTHY: "unhealthy",
} as const;

export const REDIS_UNAVAILABLE = "REDIS_UNAVAILABLE" as const;

/** The ping is bounded by the same budget the connection is given. */
function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("The Redis health check timed out."));
    }, timeoutMs);

    operation.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

/**
 * Reports whether Redis is reachable.
 *
 * When Redis is disabled this opens no connection and creates no client: the
 * check is answered from configuration alone, so calling it on every readiness
 * probe of a project that does not use Redis costs nothing.
 */
export async function checkRedisHealth(): Promise<RedisHealth> {
  const configuration = getRedisConfiguration();

  if (!configuration.enabled) {
    return { status: REDIS_HEALTH_STATUS.DISABLED };
  }

  const timer = startOperationTimer();

  try {
    const client = await getRedisClient();

    if (!client) {
      return { status: REDIS_HEALTH_STATUS.UNHEALTHY, code: REDIS_UNAVAILABLE };
    }

    await withTimeout(client.ping(), configuration.connectTimeoutMs);

    return {
      status: REDIS_HEALTH_STATUS.HEALTHY,
      latencyMs: timer.elapsedMs(),
    };
  } catch {
    // The caught value is deliberately not read. There is nothing in a driver
    // error that belongs in a health result, and reading it is how it ends up
    // there.
    return { status: REDIS_HEALTH_STATUS.UNHEALTHY, code: REDIS_UNAVAILABLE };
  }
}
