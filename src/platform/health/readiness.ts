import {
  isDependencyFailure,
  type DependencyCheckResult,
  type DependencyName,
  type DependencyReport,
} from "./dependency-check";
import { HEALTH_CODE } from "./health-code";
import { READINESS_STATUS, type ReadinessStatus } from "./health-status";

/**
 * The readiness answer, aggregated from the checks that ran.
 *
 * The shape is fixed and total: every dependency the registry declares appears
 * in `checks`, in registry order, whether it is healthy, unhealthy, or switched
 * off. A response that omitted disabled dependencies would make "we do not run
 * Redis here" and "the Redis check has not been wired up yet" look identical to
 * whoever is reading it at three in the morning.
 *
 * There is no human message anywhere in it. Not a `message`, not a `detail`, not
 * a `reason`. A readiness endpoint is read by a load balancer, a deployment gate,
 * and an operator with a terminal, none of which want a sentence — and a field
 * that can hold a sentence is a field that will eventually hold an exception.
 *
 * There is also no `timestamp`. The answer is about now by definition, the
 * response is `no-store`, and a changing byte in an otherwise identical body
 * only makes diffing two probes harder.
 */
export type ReadinessCode =
  typeof HEALTH_CODE.READY | typeof HEALTH_CODE.NOT_READY;

export type ReadinessReport = Readonly<{
  status: ReadinessStatus;
  code: ReadinessCode;
  checks: Readonly<Partial<Record<DependencyName, DependencyReport>>>;
}>;

/**
 * The two statuses this endpoint answers, and nothing between them.
 *
 * `503` rather than `500`: the process is working correctly and is telling the
 * truth about something it depends on, which is a dependency failure and not an
 * application fault. It is also the status a load balancer already knows how to
 * read — it takes the instance out of rotation and keeps probing — whereas a
 * `500` invites an alert about the endpoint itself.
 *
 * `200` is not chosen by anything a client sends. There is no query parameter, no
 * header, and no body that can influence it; it follows from the checks alone.
 */
export const READINESS_HTTP_STATUS = {
  READY: 200,
  NOT_READY: 503,
} as const;

export type ReadinessHttpStatus =
  (typeof READINESS_HTTP_STATUS)[keyof typeof READINESS_HTTP_STATUS];

export function toReadinessReport(
  results: readonly DependencyCheckResult[],
): ReadinessReport {
  const checks: Partial<Record<DependencyName, DependencyReport>> = {};
  let ready = true;

  for (const result of results) {
    checks[result.name] = result.report;

    if (isDependencyFailure(result.report)) {
      ready = false;
    }
  }

  return ready
    ? {
        status: READINESS_STATUS.READY,
        code: HEALTH_CODE.READY,
        checks,
      }
    : {
        status: READINESS_STATUS.NOT_READY,
        code: HEALTH_CODE.NOT_READY,
        checks,
      };
}

export function httpStatusForReadiness(
  report: ReadinessReport,
): ReadinessHttpStatus {
  return report.status === READINESS_STATUS.READY
    ? READINESS_HTTP_STATUS.READY
    : READINESS_HTTP_STATUS.NOT_READY;
}

/**
 * The answer given when aggregation itself could not be completed.
 *
 * It exists so the handler has something safe to return from its outermost
 * `catch` without inventing a shape. A process that cannot even assemble its own
 * readiness report is emphatically not ready, and saying so with the ordinary
 * contract is better than a `500` with a stack trace: the caller parses one
 * shape either way, and nothing about the internal failure escapes.
 */
export const UNKNOWN_READINESS_REPORT: ReadinessReport = Object.freeze({
  status: READINESS_STATUS.NOT_READY,
  code: HEALTH_CODE.NOT_READY,
  checks: Object.freeze({}),
});
