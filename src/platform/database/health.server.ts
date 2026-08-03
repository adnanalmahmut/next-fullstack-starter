import "server-only";

import { startOperationTimer } from "@/platform/observability/operation-timer.server";

import { database } from "./prisma";

/**
 * The PostgreSQL health contract.
 *
 * It belongs to this directory rather than to the health platform for the same
 * reason the Redis and storage checks belong to theirs: the question "is the
 * database answering" can only be asked by the area that owns the client, and a
 * readiness endpoint that reached for Prisma itself would be a second place
 * connections are opened.
 *
 * Two outcomes, and no third. There is no `disabled`: PostgreSQL is the one
 * dependency this application cannot run without, so a deployment that cannot
 * reach it is not ready, and there is no configuration in which that becomes an
 * acceptable state.
 *
 * `unhealthy` carries a stable code and nothing else. A health result is the
 * single most likely thing in a system to be rendered on a page or shipped to a
 * status dashboard, so it is exactly where a connection string, a host name, a
 * schema name, or a raw driver message must not be able to reach.
 */
export const DATABASE_HEALTH_STATUS = {
  HEALTHY: "healthy",
  UNHEALTHY: "unhealthy",
} as const;

export type DatabaseHealthStatus =
  (typeof DATABASE_HEALTH_STATUS)[keyof typeof DATABASE_HEALTH_STATUS];

export const DATABASE_UNAVAILABLE = "DATABASE_UNAVAILABLE" as const;

export type DatabaseHealth =
  | Readonly<{
      status: typeof DATABASE_HEALTH_STATUS.HEALTHY;
      latencyMs: number;
    }>
  | Readonly<{
      status: typeof DATABASE_HEALTH_STATUS.UNHEALTHY;
      code: typeof DATABASE_UNAVAILABLE;
    }>;

/**
 * The budget a probe gets.
 *
 * Short on purpose. A readiness probe is called by a load balancer on a fixed
 * interval, and a check that waited ten seconds for a database that is gone
 * would keep the endpoint open long enough for the probes to queue up behind
 * each other.
 */
export const DATABASE_HEALTH_TIMEOUT_MS = 2_000;

/**
 * The one capability a probe needs.
 *
 * Narrowed to a single method so the check can be given a fake in a test — a
 * failure mapping has to be provable, and the alternative is stopping a
 * PostgreSQL container that other suites are using. The shared client satisfies
 * it structurally, which is what keeps the production path free of an injection
 * seam nobody uses.
 */
export type DatabaseHealthProbe = Readonly<{
  $queryRaw: (
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown>;
}>;

/**
 * Bounds one probe.
 *
 * The timer is cleared on both paths. A probe that ran every few seconds and
 * left a timer behind each time would be a slow leak in the one endpoint most
 * likely to be called forever.
 *
 * A timed-out query is not cancelled — PostgreSQL keeps running it and the
 * connection is returned to the pool when it finishes. That is a deliberate
 * trade: the alternative is a cancellation path that has to be correct under
 * exactly the conditions in which nothing is working.
 */
async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("The database health check exceeded its budget."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Reports whether PostgreSQL is answering.
 *
 * The query is `SELECT 1`. It reads no table, touches no business row, creates
 * nothing, and changes nothing, so running it on every probe of every process
 * forever costs one round trip and leaves no trace. It is a tagged template
 * rather than `$queryRawUnsafe`, so there is no string a caller could influence
 * — the check takes no input at all.
 *
 * It uses the shared client, so a probe never opens a pool of its own.
 */
export async function checkDatabaseHealth(
  client: DatabaseHealthProbe = database,
): Promise<DatabaseHealth> {
  const timer = startOperationTimer();

  try {
    await withTimeout(
      () => client.$queryRaw`SELECT 1`,
      DATABASE_HEALTH_TIMEOUT_MS,
    );

    return {
      status: DATABASE_HEALTH_STATUS.HEALTHY,
      latencyMs: timer.elapsedMs(),
    };
  } catch {
    // The caught value is deliberately not read. A Prisma error carries the
    // connection target, and often the statement; reading it here is how those
    // reach a health response.
    return {
      status: DATABASE_HEALTH_STATUS.UNHEALTHY,
      code: DATABASE_UNAVAILABLE,
    };
  }
}
