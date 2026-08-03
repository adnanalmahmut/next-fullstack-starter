import { HEALTH_RESPONSE_HEADERS } from "./health-headers";
import type { LivenessReport } from "./liveness";

/**
 * The liveness serializer, kept apart from the readiness one.
 *
 * The separation is structural rather than tidy. A single serializer module would
 * put the readiness document's types — and therefore the dependency port they are
 * built from — inside the liveness route's import graph. Nothing there opens a
 * socket today, but the whole guarantee of this endpoint is a property of its
 * reachable set, and a guarantee that depends on nobody adding a runtime import to
 * a neighbouring file is not a guarantee.
 *
 * A separate, narrow serializer rather than a reuse of
 * `@/platform/http/json-response.ts`: the versioned API answers a `{"data": …}`
 * envelope and maps a closed set of error codes onto statuses, while an
 * operational probe answers a flat document. Teaching the API serializer about
 * health would put an operational concern inside the boundary every business
 * endpoint depends on.
 */
export const LIVENESS_HTTP_STATUS = 200 as const;

export function livenessResponse(report: LivenessReport): Response {
  return Response.json(report, {
    status: LIVENESS_HTTP_STATUS,
    headers: { ...HEALTH_RESPONSE_HEADERS },
  });
}
