import "server-only";

/**
 * The controlled server-only entry point for the operational health contracts.
 *
 * This area has three entry points rather than one, and the split is by
 * *process*, because the three sets of code that may be reached are genuinely
 * different — not as a convenience.
 *
 * | Entry point | Imported by | May reach |
 * | --- | --- | --- |
 * | `index.server.ts` | the worker command | the contracts and the logger, nothing else |
 * | `liveness.server.ts` | `GET /api/health/live` | two constant modules and `next/server` |
 * | `readiness.server.ts` | `GET /api/health/ready` | the above plus database, Redis, storage |
 *
 * **This file** holds what every process shares: the closed code set, the status
 * vocabularies, the dependency port, the immutable registry, the bounded
 * orchestration, and the worker readiness contract. It imports no request API, no
 * Prisma, no Redis, no AWS SDK, and nothing from `@/platform/jobs`. That is what
 * lets `pnpm jobs:health` — a plain Node process — use it without dragging Next.js
 * request machinery or an object-storage SDK into a worker, and what lets a
 * generated project delete the jobs area without editing this directory.
 *
 * **The two handler entry points** are separate because each pulls something this
 * file must not: `next/server`, and in the readiness case the three platform areas
 * a probe asks about. A liveness route that reached its handler through a shared
 * module would construct a Prisma client in order to answer a question that
 * touches nothing — and would still return `200`, so nothing would ever reveal it.
 *
 * A dependency-cruiser reachability rule and a contract test assert each row of
 * that table, so the boundaries hold against an ordinary-looking import added
 * later.
 *
 * Importing this module opens no connection, reads no environment variable, and
 * runs no check. Nothing is registered at import time and nothing is held on
 * `globalThis`: a registry is a value a composition function builds and hands to a
 * handler.
 */

export {
  DEPENDENCY_FAILURE_CODE,
  DEPENDENCY_NAME,
  DEPENDENCY_NAMES,
  DISABLED_DEPENDENCY,
  HEALTHY_DEPENDENCY,
  isDependencyFailure,
  MAX_DEPENDENCY_TIMEOUT_MS,
  MIN_DEPENDENCY_TIMEOUT_MS,
  unhealthyDependency,
  type DependencyCheck,
  type DependencyCheckResult,
  type DependencyName,
  type DependencyReport,
} from "./dependency-check";

export {
  HEALTH_CODE,
  HEALTH_CODES,
  isHealthCode,
  type HealthCode,
} from "./health-code";

export {
  HEALTH_LOG_FIELD_NAMES,
  toHealthLogFields,
  type HealthLogFields,
  type HealthLogInput,
} from "./health-log-fields";

export {
  HEALTH_LOG_LEVEL,
  logHealthEvent,
  type HealthLogLevel,
} from "./health-logger.server";

export { createHealthRegistry, type HealthRegistry } from "./health-registry";

export {
  DEPENDENCY_STATUS,
  HEALTH_PROCESS,
  LIVENESS_STATUS,
  READINESS_STATUS,
  WORKER_READINESS_STATUS,
  type DependencyStatus,
  type HealthProcess,
  type LivenessStatus,
  type ReadinessStatus,
  type WorkerReadinessStatus,
} from "./health-status";

export { LIVENESS_REPORT, type LivenessReport } from "./liveness";

export {
  HEALTH_LOG_EVENT,
  HEALTH_LOG_EVENTS,
  type HealthLogEvent,
} from "./log-event";

export {
  httpStatusForReadiness,
  READINESS_HTTP_STATUS,
  toReadinessReport,
  UNKNOWN_READINESS_REPORT,
  type ReadinessCode,
  type ReadinessHttpStatus,
  type ReadinessReport,
} from "./readiness";

export { runHealthChecks } from "./run-health-checks.server";

export {
  checkWorkerReadiness,
  logWorkerReadiness,
  WORKER_READINESS_TIMEOUT_MS,
  type WorkerReadinessInput,
  type WorkerReadinessReport,
} from "./worker-readiness.server";
