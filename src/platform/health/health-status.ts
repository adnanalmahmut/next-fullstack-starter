/**
 * The closed status vocabularies of the health contracts.
 *
 * There are four, and they are kept apart rather than merged into one general
 * status enum. A merged set would let a liveness response claim `not_ready` and
 * a dependency claim `live`, and the type system would have nothing to say about
 * either.
 */

/**
 * Liveness has one answer.
 *
 * That is the whole point of it: a liveness probe asks "is this process running"
 * and a process that can answer at all is running. A liveness endpoint with two
 * possible answers is a readiness endpoint that has been given the wrong name,
 * and the consequence is an orchestrator restarting a healthy process because a
 * database it does not own went away.
 */
export const LIVENESS_STATUS = {
  LIVE: "live",
} as const;

export type LivenessStatus =
  (typeof LIVENESS_STATUS)[keyof typeof LIVENESS_STATUS];

/**
 * Readiness has two.
 *
 * `not_ready` is snake_case because it is a wire value that operational tooling
 * matches on, and every other value in this file is a single lowercase word;
 * choosing `notReady` here would make the one multi-word value the one that has
 * to be remembered differently.
 */
export const READINESS_STATUS = {
  READY: "ready",
  NOT_READY: "not_ready",
} as const;

export type ReadinessStatus =
  (typeof READINESS_STATUS)[keyof typeof READINESS_STATUS];

/**
 * A single dependency has three.
 *
 * `disabled` is the one that earns its place. An optional dependency that is
 * switched off is not a degraded state and must never make a process look
 * unhealthy — a deployment that stores no files and caches nothing is a
 * supported deployment, not a broken one. Reporting it explicitly, rather than
 * omitting the dependency, means a probe's output says which optional pieces
 * this deployment runs rather than leaving an operator to infer it.
 *
 * There is deliberately no `misconfigured` here. A misconfigured dependency
 * still means the process is not ready, so it is reported as `unhealthy` with a
 * code that says which kind of failure it is. Adding a fourth status would give
 * the same fact two representations and force every consumer to handle both.
 */
export const DEPENDENCY_STATUS = {
  HEALTHY: "healthy",
  UNHEALTHY: "unhealthy",
  DISABLED: "disabled",
} as const;

export type DependencyStatus =
  (typeof DEPENDENCY_STATUS)[keyof typeof DEPENDENCY_STATUS];

/**
 * A worker has three, and the third is the reason this vocabulary is separate
 * from the web one.
 *
 * `misconfigured` distinguishes "this will never start until someone changes a
 * variable" from "this could not reach something and may recover", which is
 * exactly the distinction a supervisor needs in order to stop restarting the
 * first one in a tight loop. The web process has no equivalent, because a web
 * process with a missing optional variable still serves requests.
 */
export const WORKER_READINESS_STATUS = {
  READY: "ready",
  NOT_READY: "not_ready",
  MISCONFIGURED: "misconfigured",
} as const;

export type WorkerReadinessStatus =
  (typeof WORKER_READINESS_STATUS)[keyof typeof WORKER_READINESS_STATUS];

/** The process a health line or report belongs to. */
export const HEALTH_PROCESS = {
  WEB: "web",
  WORKER: "worker",
} as const;

export type HealthProcess =
  (typeof HEALTH_PROCESS)[keyof typeof HEALTH_PROCESS];
