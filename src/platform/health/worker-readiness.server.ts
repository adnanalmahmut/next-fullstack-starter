import "server-only";

import {
  DEPENDENCY_FAILURE_CODE,
  DEPENDENCY_NAME,
  MAX_DEPENDENCY_TIMEOUT_MS,
  MIN_DEPENDENCY_TIMEOUT_MS,
  type DependencyReport,
} from "./dependency-check";
import { HEALTH_CODE, type HealthCode } from "./health-code";
import { logHealthEvent, HEALTH_LOG_LEVEL } from "./health-logger.server";
import { createHealthRegistry } from "./health-registry";
import {
  DEPENDENCY_STATUS,
  HEALTH_PROCESS,
  WORKER_READINESS_STATUS,
  type DependencyStatus,
  type WorkerReadinessStatus,
} from "./health-status";
import { HEALTH_LOG_EVENT } from "./log-event";
import { runHealthChecks } from "./run-health-checks.server";

/**
 * The worker readiness contract.
 *
 * A worker is not a web process and its readiness is not the web's readiness, so
 * it gets its own contract rather than a flag on the other one. The two differ in
 * every dimension that matters:
 *
 * | | Web | Worker |
 * | --- | --- | --- |
 * | PostgreSQL | required | required |
 * | Redis cache | optional | not checked |
 * | Object storage | optional | not checked |
 * | Queue Redis | **not checked** | **required** |
 * | `JOBS_ENABLED=false` | normal | misconfiguration |
 * | Answer | HTTP `200`/`503` | exit code |
 *
 * The two asymmetries in the middle are the point. A web process records work by
 * inserting an outbox row inside the transaction that earns it, so it serves
 * requests correctly with no queue anywhere and must not be drained from a load
 * balancer because a worker is down. A worker exists only to consume that queue,
 * so a worker without a queue address is not degraded — it is a deployment
 * mistake, and saying so is the difference between an operator finding it in
 * seconds and finding it after an afternoon of wondering why nothing is running.
 *
 * ## Why the checks are injected
 *
 * `checkDatabase` and `checkQueue` are parameters, and the queue check is
 * deliberately not imported here. If this file imported `@/platform/jobs`, then
 * background jobs would become a dependency of the health platform, and the
 * property that a generated project can delete `src/platform/jobs` and
 * `src/worker` and still build would be false. The worker entry point already
 * depends on both areas; it is the right place for them to meet. This platform
 * supplies the contract, the bounding, and the containment.
 *
 * ## No HTTP server
 *
 * This is a function, and `pnpm jobs:health` is a one-shot command that exits.
 * Nothing here opens a port. Adding an HTTP listener to the worker would mean the
 * worker had to be reachable, which means a service, an ingress, a port, and a
 * second unauthenticated surface — and it would then be a web process with a
 * consumer bolted on rather than a worker. A supervisor that needs a probe runs
 * this command; the exit code is the answer.
 */
export type WorkerReadinessInput = Readonly<{
  /** `JOBS_ENABLED`. `false` in a worker deployment is a misconfiguration. */
  jobsEnabled: boolean;
  /** Whether a queue address is present as well as the flag. */
  queueConfigured: boolean;
  checkDatabase: () => Promise<DependencyReport>;
  checkQueue: () => Promise<DependencyReport>;
  databaseTimeoutMs?: number;
  queueTimeoutMs?: number;
}>;

export type WorkerReadinessReport = Readonly<{
  process: typeof HEALTH_PROCESS.WORKER;
  status: WorkerReadinessStatus;
  code: HealthCode;
  databaseStatus: DependencyStatus;
  queueStatus: DependencyStatus;
}>;

export const WORKER_READINESS_TIMEOUT_MS = {
  DATABASE: 2_000,
  QUEUE: 5_000,
} as const;

const WORKER_CODE_BY_STATUS = {
  [WORKER_READINESS_STATUS.READY]: HEALTH_CODE.WORKER_READY,
  [WORKER_READINESS_STATUS.NOT_READY]: HEALTH_CODE.WORKER_NOT_READY,
  [WORKER_READINESS_STATUS.MISCONFIGURED]: HEALTH_CODE.WORKER_MISCONFIGURED,
} as const satisfies Record<WorkerReadinessStatus, HealthCode>;

/**
 * The answer given when the worker cannot run as configured.
 *
 * No check runs on this path, and the two dependency statuses are reported as
 * `disabled` rather than guessed at: a worker that has no queue address has not
 * been asked whether Redis is up, and claiming otherwise in a log line would be
 * inventing a fact. Not opening the connections is also the correct behaviour —
 * there is nothing useful to learn from a database that a misconfigured process
 * will never use.
 */
function misconfigured(): WorkerReadinessReport {
  return {
    process: HEALTH_PROCESS.WORKER,
    status: WORKER_READINESS_STATUS.MISCONFIGURED,
    code: WORKER_CODE_BY_STATUS[WORKER_READINESS_STATUS.MISCONFIGURED],
    databaseStatus: DEPENDENCY_STATUS.DISABLED,
    queueStatus: DEPENDENCY_STATUS.DISABLED,
  };
}

/**
 * Brings a caller's budget inside the range the registry accepts.
 *
 * It clamps rather than validating, and that is the point: this function is on the
 * path of a probe, and a probe that threw because somebody asked for 50 ms would be
 * a probe that fails for a reason unrelated to the thing it was asked about. The
 * registry's own validation stays strict — it is what catches a malformed
 * *composition* — while a caller's preference is treated as a preference.
 *
 * Rounded because the bound must be an integer, and a fractional millisecond is a
 * caller being imprecise rather than a caller being wrong.
 */
function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(
    MAX_DEPENDENCY_TIMEOUT_MS,
    Math.max(MIN_DEPENDENCY_TIMEOUT_MS, Math.round(value)),
  );
}

export async function checkWorkerReadiness(
  input: WorkerReadinessInput,
): Promise<WorkerReadinessReport> {
  if (!input.jobsEnabled || !input.queueConfigured) {
    return misconfigured();
  }

  const registry = createHealthRegistry([
    {
      name: DEPENDENCY_NAME.DATABASE,
      timeoutMs: boundedTimeout(
        input.databaseTimeoutMs,
        WORKER_READINESS_TIMEOUT_MS.DATABASE,
      ),
      failureCode: DEPENDENCY_FAILURE_CODE.DATABASE,
      run: input.checkDatabase,
    },
    {
      name: DEPENDENCY_NAME.QUEUE,
      timeoutMs: boundedTimeout(
        input.queueTimeoutMs,
        WORKER_READINESS_TIMEOUT_MS.QUEUE,
      ),
      failureCode: DEPENDENCY_FAILURE_CODE.QUEUE,
      run: input.checkQueue,
    },
  ]);

  const results = await runHealthChecks(registry);

  const databaseStatus =
    results.find((result) => result.name === DEPENDENCY_NAME.DATABASE)?.report
      .status ?? DEPENDENCY_STATUS.UNHEALTHY;
  const queueStatus =
    results.find((result) => result.name === DEPENDENCY_NAME.QUEUE)?.report
      .status ?? DEPENDENCY_STATUS.UNHEALTHY;

  // A worker's queue has no supported disabled state at this point: the two
  // configuration cases that produce one were answered above, so a `disabled`
  // here would mean the injected check disagrees with the configuration it was
  // built from. That is not readiness.
  const ready =
    databaseStatus === DEPENDENCY_STATUS.HEALTHY &&
    queueStatus === DEPENDENCY_STATUS.HEALTHY;

  const status = ready
    ? WORKER_READINESS_STATUS.READY
    : WORKER_READINESS_STATUS.NOT_READY;

  return {
    process: HEALTH_PROCESS.WORKER,
    status,
    code: WORKER_CODE_BY_STATUS[status],
    databaseStatus,
    queueStatus,
  };
}

/**
 * Writes the one line the worker health command produces.
 *
 * The level follows the verdict, because that is what decides whether anybody
 * needs to look: a ready worker is `info`, and both failing verdicts are `error`
 * — a misconfigured worker will never start on its own, and an unready one is
 * waiting on something that is down.
 */
export function logWorkerReadiness(report: WorkerReadinessReport): void {
  logHealthEvent(
    report.status === WORKER_READINESS_STATUS.READY
      ? HEALTH_LOG_LEVEL.INFO
      : HEALTH_LOG_LEVEL.ERROR,
    HEALTH_LOG_EVENT.WORKER_READINESS_CHECKED,
    {
      process: report.process,
      status: report.status,
      code: report.code,
      databaseStatus: report.databaseStatus,
      queueStatus: report.queueStatus,
    },
  );
}
