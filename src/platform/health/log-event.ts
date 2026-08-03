/**
 * Stable log event names for operational health.
 *
 * There are two, and there is deliberately no event for a successful readiness
 * probe. A load balancer calls that endpoint every few seconds for the lifetime
 * of a deployment; logging each success would produce a line per instance per
 * interval forever, drown everything else, and cost money to store — and it would
 * tell an operator nothing, because the absence of a failure line already says
 * the probe is passing.
 *
 * The worker check is the opposite case. It is a one-shot command an operator or
 * a deployment step runs on purpose, and its log line *is* its output, so it is
 * written on success as well. The level follows the verdict: `info` when ready,
 * `error` when not, because only one of the two is something to act on.
 */
export const HEALTH_LOG_EVENT = {
  /** Written only when a web readiness probe answers `not_ready`. */
  READINESS_FAILED: "health.readiness.failed",

  /** Written once per `jobs:health` run, at a level that follows the verdict. */
  WORKER_READINESS_CHECKED: "health.worker.checked",
} as const;

export type HealthLogEvent =
  (typeof HEALTH_LOG_EVENT)[keyof typeof HEALTH_LOG_EVENT];

export const HEALTH_LOG_EVENTS: readonly HealthLogEvent[] = Object.freeze(
  Object.values(HEALTH_LOG_EVENT),
);
