import "server-only";

import { connection } from "next/server";

import { startOperationTimer } from "@/platform/observability/operation-timer.server";

import {
  DEPENDENCY_NAME,
  type DependencyCheckResult,
} from "./dependency-check";
import { logHealthEvent, HEALTH_LOG_LEVEL } from "./health-logger.server";
import type { HealthRegistry } from "./health-registry";
import {
  HEALTH_PROCESS,
  READINESS_STATUS,
  type DependencyStatus,
} from "./health-status";
import { HEALTH_LOG_EVENT } from "./log-event";
import { readinessResponse } from "./readiness-response";
import {
  httpStatusForReadiness,
  READINESS_HTTP_STATUS,
  toReadinessReport,
  UNKNOWN_READINESS_REPORT,
} from "./readiness";
import { runHealthChecks } from "./run-health-checks.server";

/**
 * The web readiness entry point, and one of this area's three controlled ones.
 *
 * It is the only module a `route.ts` needs for `/api/health/ready`, and the only
 * one in this directory allowed to reach `@/platform/database`,
 * `@/platform/redis`, and `@/platform/storage`. The shared entry point,
 * `index.server.ts`, deliberately reaches none of them, so a worker process can
 * use the contracts without loading Next.js request machinery or an S3 client.
 */
export {
  createWebReadinessRegistry,
  toDatabaseReport,
  toRedisReport,
  toStorageReport,
  WEB_READINESS_TIMEOUT_MS,
} from "./web-readiness.server";

/**
 * The readiness handler, built from a registry.
 *
 * The registry is a parameter rather than something this file reaches for, which
 * is what keeps the composition visible at the route and makes the handler
 * testable against any set of checks. It is captured once, when the route module
 * is evaluated, and never replaced.
 *
 * ## Why not `defineRoute`
 *
 * `defineRoute` is the right adapter for every business endpoint and the wrong
 * one here, on four counts. It answers a `{"data": …}` envelope, and an
 * operational probe is a flat document that external tooling matches on. It maps
 * a closed set of error codes onto statuses, whereas readiness needs a `503` that
 * is not an error — nothing failed, a dependency is simply absent. It resolves a
 * request context, runs hooks, and can authenticate, none of which a probe called
 * by a load balancer with no credentials should touch. And it is the boundary
 * every business route depends on: teaching it about health would put an
 * operational special case inside the code path that serves customers.
 *
 * So this is a separate, narrow adapter. It is confined to two route files by a
 * dependency-cruiser rule and a contract test, so the exception cannot grow into
 * a general escape hatch from `defineRoute`.
 *
 * ## Why `connection()`
 *
 * With Cache Components enabled, a `GET` handler is prerendered when it performs
 * no uncached I/O. This one does perform I/O, so it would be deferred to request
 * time anyway — but relying on that would mean relying on `next build` correctly
 * detecting a Prisma query, and the failure mode if it did not is severe: the
 * build would run the checks against whatever was reachable from the build
 * machine and freeze that answer into a static document. `connection()` states
 * the requirement instead of inferring it, and is the supported mechanism now
 * that `export const dynamic` is removed under Cache Components.
 *
 * ## Containment
 *
 * `runHealthChecks` cannot reject, so the ordinary path has no error branch. The
 * outer `catch` covers the rest — a registry that turns out to be malformed, a
 * logger that throws — and answers the ordinary `not_ready` document rather than
 * letting a `500` with a stack trace out of an unauthenticated endpoint. A probe
 * that cannot assemble its own answer is not ready, and that is the honest thing
 * to say.
 */
/**
 * The per-dependency statuses a failing line carries.
 *
 * Three dependencies, because a web registry has exactly three. `queueStatus` is
 * deliberately not among them: web readiness never checks the queue, so a branch
 * for it would be code that can never run, and its presence would suggest the
 * endpoint might one day report on a worker.
 *
 * Each is omitted when the registry did not declare it, so a line never claims to
 * know the state of something that was not checked.
 */
function dependencyStatusFields(
  results: readonly DependencyCheckResult[],
): Readonly<{
  databaseStatus?: DependencyStatus;
  redisStatus?: DependencyStatus;
  storageStatus?: DependencyStatus;
}> {
  const byName = new Map<string, DependencyStatus>(
    results.map((result) => [result.name, result.report.status]),
  );

  const database = byName.get(DEPENDENCY_NAME.DATABASE);
  const redis = byName.get(DEPENDENCY_NAME.REDIS);
  const storage = byName.get(DEPENDENCY_NAME.STORAGE);

  return {
    ...(database === undefined ? {} : { databaseStatus: database }),
    ...(redis === undefined ? {} : { redisStatus: redis }),
    ...(storage === undefined ? {} : { storageStatus: storage }),
  };
}

export function createReadinessHandler(
  registry: HealthRegistry,
): () => Promise<Response> {
  return async () => {
    await connection();

    try {
      const timer = startOperationTimer();
      const results = await runHealthChecks(registry);
      const report = toReadinessReport(results);

      if (report.status === READINESS_STATUS.NOT_READY) {
        // Only the failing case is logged. A successful probe runs every few
        // seconds forever, and a line per success would bury the ones that
        // matter. The latency lives here rather than in the response body: it is
        // useful to an operator and is infrastructure detail to everybody else.
        logHealthEvent(
          HEALTH_LOG_LEVEL.WARN,
          HEALTH_LOG_EVENT.READINESS_FAILED,
          {
            process: HEALTH_PROCESS.WEB,
            status: report.status,
            code: report.code,
            ...dependencyStatusFields(results),
            durationMs: timer.elapsedMs(),
          },
        );
      }

      return readinessResponse(report, httpStatusForReadiness(report));
    } catch {
      // Deliberately not read, and deliberately not rethrown. See above.
      return readinessResponse(
        UNKNOWN_READINESS_REPORT,
        READINESS_HTTP_STATUS.NOT_READY,
      );
    }
  };
}
