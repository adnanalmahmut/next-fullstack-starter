import { HEALTH_CODE, type HealthCode } from "./health-code";
import { DEPENDENCY_STATUS } from "./health-status";

/**
 * The port a dependency check satisfies.
 *
 * This platform implements no check of its own. It cannot: whether PostgreSQL is
 * answering is a question only the area that owns the client can ask, and the
 * same is true of Redis, of the object store, and of the queue. What this
 * platform owns is the *shape* — a bounded call that answers one of three
 * statuses and never throws anything the caller has to interpret — and the
 * orchestration around it.
 *
 * The direction matters. If the health platform reached into Prisma, into the
 * Redis driver, and into the AWS SDK to build its own probes, then every one of
 * those would become a dependency of the endpoint a load balancer calls, and
 * removing an optional area from a generated project would mean editing this
 * directory. Instead the owning area exports a check, and a composition function
 * hands it over. That is also why a check carries its own failure code: only the
 * owner knows what its own failure is called.
 */
export const DEPENDENCY_NAME = {
  DATABASE: "database",
  REDIS: "redis",
  STORAGE: "storage",
  QUEUE: "queue",
} as const;

export type DependencyName =
  (typeof DEPENDENCY_NAME)[keyof typeof DEPENDENCY_NAME];

export const DEPENDENCY_NAMES: readonly DependencyName[] = Object.freeze(
  Object.values(DEPENDENCY_NAME),
);

/**
 * What a check answers, and the whole of what reaches a response body.
 *
 * A healthy or disabled dependency carries nothing at all — no latency, no
 * endpoint, no version, no host. An unhealthy one carries a code and nothing
 * else. There is no field here for a message, and that absence is the design:
 * you cannot leak a provider's response through a type that has nowhere to put
 * it.
 */
export type DependencyReport =
  | Readonly<{ status: typeof DEPENDENCY_STATUS.HEALTHY }>
  | Readonly<{ status: typeof DEPENDENCY_STATUS.DISABLED }>
  | Readonly<{
      status: typeof DEPENDENCY_STATUS.UNHEALTHY;
      code: HealthCode;
    }>;

/**
 * The bounds a check runs under.
 *
 * Every check declares its own budget rather than sharing one, because the calls
 * are not comparable: a `SELECT 1` on a warm pool and a `HeadBucket` across the
 * internet fail on very different timescales, and one number would either cut
 * the second one off or let the first one hold a probe open.
 *
 * The bounds below are the outer limits the registry enforces. The floor exists
 * because a check given a few milliseconds would report a healthy dependency as
 * unavailable under any load at all; the ceiling exists because a readiness
 * probe is called on an interval and a check allowed to wait a minute would
 * queue the probes up behind each other.
 */
export const MIN_DEPENDENCY_TIMEOUT_MS = 100;
export const MAX_DEPENDENCY_TIMEOUT_MS = 5_000;

export type DependencyCheck = Readonly<{
  name: DependencyName;
  timeoutMs: number;
  /**
   * The code reported when `run` throws, rejects, or exceeds its budget.
   *
   * It is declared rather than derived. A code taken from the thrown value would
   * carry the thrown value's contents into a public response, and would leave
   * the published set open to whatever a driver decides to call things next.
   */
  failureCode: HealthCode;
  run: () => Promise<DependencyReport>;
}>;

/**
 * One check's outcome, internally.
 *
 * `durationMs` is here and is deliberately not in `DependencyReport`: latency is
 * genuinely useful to an operator reading a log line, and genuinely unwelcome in
 * a public probe response, where it is both a fingerprint of the infrastructure
 * and a number that makes the body change on every request.
 */
export type DependencyCheckResult = Readonly<{
  name: DependencyName;
  report: DependencyReport;
  durationMs: number;
}>;

/** The healthy report, which carries nothing. */
export const HEALTHY_DEPENDENCY: DependencyReport = Object.freeze({
  status: DEPENDENCY_STATUS.HEALTHY,
});

/** The disabled report, which carries nothing and is never a failure. */
export const DISABLED_DEPENDENCY: DependencyReport = Object.freeze({
  status: DEPENDENCY_STATUS.DISABLED,
});

/** An unhealthy report, which carries a published code and nothing else. */
export function unhealthyDependency(code: HealthCode): DependencyReport {
  return { status: DEPENDENCY_STATUS.UNHEALTHY, code };
}

/**
 * `true` when a report should stop a process being ready.
 *
 * Only `unhealthy` does. `disabled` never does, which is the single rule that
 * makes every optional dependency in this repository genuinely optional rather
 * than optional until someone adds a probe.
 */
export function isDependencyFailure(report: DependencyReport): boolean {
  return report.status === DEPENDENCY_STATUS.UNHEALTHY;
}

/**
 * The code a caller may use when it has nothing more specific.
 *
 * Exported so a composition never has to write a literal, and typed to the
 * closed set so a typo does not compile.
 */
export const DEPENDENCY_FAILURE_CODE = {
  DATABASE: HEALTH_CODE.DATABASE_UNAVAILABLE,
  REDIS: HEALTH_CODE.REDIS_UNAVAILABLE,
  STORAGE: HEALTH_CODE.STORAGE_UNAVAILABLE,
  QUEUE: HEALTH_CODE.JOBS_REDIS_UNAVAILABLE,
} as const;
