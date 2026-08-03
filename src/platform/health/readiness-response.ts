import { HEALTH_RESPONSE_HEADERS } from "./health-headers";
import {
  READINESS_HTTP_STATUS,
  type ReadinessHttpStatus,
  type ReadinessReport,
} from "./readiness";

/**
 * The readiness serializer.
 *
 * The status is a parameter rather than something derived here, so the one place
 * that decides ready-or-not is `httpStatusForReadiness` and this file only writes
 * what it was told. The default is `200` so a caller cannot accidentally serialize
 * a ready document as unavailable by forgetting an argument.
 *
 * The document is written flat, with no envelope: an operational probe is read by
 * tooling that matches on the document itself, and `{"data": …}` would make every
 * load balancer rule and every alert expression carry an extra hop.
 */
export function readinessResponse(
  report: ReadinessReport,
  status: ReadinessHttpStatus = READINESS_HTTP_STATUS.READY,
): Response {
  return Response.json(report, {
    status,
    headers: { ...HEALTH_RESPONSE_HEADERS },
  });
}
