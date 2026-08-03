import "server-only";

import {
  captureUnexpectedError,
  ERROR_BOUNDARY,
  recordRouteRequest,
  SPAN_OUTCOME,
  startOperationTimer,
  withActiveSpan,
  type SpanOutcome,
} from "@/platform/observability/index.server";
import { ERROR_CODE, type ErrorCode } from "@/shared/errors/error-code";

/**
 * The route boundary's span and metrics, in one place.
 *
 * `defineRoute` wraps every application endpoint, so instrumenting it once here is
 * what makes every endpoint traced and measured without a single route file
 * mentioning telemetry. A route that opted in by hand would be a route somebody
 * later forgot.
 *
 * ## The identity is the route name, never the URL
 *
 * The span name and the metric dimension both come from `definition.name` — a
 * stable identifier such as `identity.user.list`, declared in code. The request URL
 * is deliberately never used: `/api/v1/admin/users/8f3c…/role` would create one
 * span name and one metric series per user, which is unusable as a metric and is a
 * disclosure as a span. The same reasoning excludes the query string, the params,
 * the body, the output, the headers, the cookies, the actor, and the idempotency
 * key. The request id is excluded from *metric* dimensions in particular: it is
 * unique per request, so it would produce one time series per request.
 *
 * ## Exactly one measurement per request
 *
 * The route body reports its outcome through `report`, and the counter and the
 * histogram are recorded once, in `finally`. Recording at each of `defineRoute`'s
 * exits — success, replay, refusal, failure — would be four call sites and
 * eventually a double count; one recording per wrapped call is one per request by
 * construction. A body that somehow returns without reporting is recorded as a
 * failed `500`, which is the only honest reading of "the handler did not say".
 *
 * Nothing here can change a response. Span creation, attribute setting, status
 * setting, and metric recording are each contained by the observability contract,
 * and the outcome the caller reports is the only thing that crosses back.
 */
export const ROUTE_SPAN_ATTRIBUTE = {
  OPERATION_NAME: "app.operation.name",
  OPERATION_TYPE: "app.operation.type",
  REQUEST_METHOD: "http.request.method",
  RESPONSE_STATUS_CODE: "http.response.status_code",
} as const;

export const ROUTE_OPERATION_TYPE = "route";

export type RouteTelemetryIdentity = Readonly<{
  routeName: string;
  method: string;
}>;

export type RouteTelemetryReporter = Readonly<{
  /**
   * Records how the request ended. The last call wins, so a caller may report a
   * provisional outcome and correct it.
   */
  report: (
    outcome: SpanOutcome,
    statusCode: number,
    errorCode?: ErrorCode,
  ) => void;
  /**
   * Reports an unexpected failure to the error monitor, with the route's identity.
   *
   * It lives here rather than at the `catch` in `defineRoute` so the boundary name,
   * the operation name, and the request id are attached in one place, and so the
   * expected-error filter is applied by the observability platform rather than
   * restated by the adapter.
   */
  captureFailure: (error: unknown, errorCode: ErrorCode) => void;
}>;

/** The status recorded when a wrapped body never reported an outcome. */
const UNREPORTED_STATUS_CODE = 500;

export async function withRouteTelemetry<T>(
  identity: RouteTelemetryIdentity,
  requestId: string,
  run: (telemetry: RouteTelemetryReporter) => Promise<T>,
): Promise<T> {
  const timer = startOperationTimer();

  let outcome: SpanOutcome = SPAN_OUTCOME.FAILED;
  let statusCode = UNREPORTED_STATUS_CODE;
  let errorCode: ErrorCode | undefined = ERROR_CODE.INTERNAL_ERROR;

  return withActiveSpan(
    `${ROUTE_OPERATION_TYPE}.${identity.routeName}`,
    {
      [ROUTE_SPAN_ATTRIBUTE.OPERATION_NAME]: identity.routeName,
      [ROUTE_SPAN_ATTRIBUTE.OPERATION_TYPE]: ROUTE_OPERATION_TYPE,
      [ROUTE_SPAN_ATTRIBUTE.REQUEST_METHOD]: identity.method,
    },
    async (span) => {
      try {
        return await run({
          report: (reportedOutcome, reportedStatus, reportedErrorCode) => {
            outcome = reportedOutcome;
            statusCode = reportedStatus;
            errorCode = reportedErrorCode;
          },
          captureFailure: (error, failureCode) => {
            captureUnexpectedError(error, {
              boundary: ERROR_BOUNDARY.ROUTE,
              operationName: identity.routeName,
              errorCode: failureCode,
              requestId,
            });
          },
        });
      } finally {
        span.setAttributes({
          [ROUTE_SPAN_ATTRIBUTE.RESPONSE_STATUS_CODE]: statusCode,
        });
        span.setOutcome(outcome, errorCode);

        recordRouteRequest({
          routeName: identity.routeName,
          method: identity.method,
          statusCode,
          outcome,
          // Measured here rather than reusing the adapter's own timer, so the
          // duration covers the whole wrapped call including the post-success
          // observers — which is what a client actually waited for.
          durationMs: timer.elapsedMs(),
        });
      }
    },
  );
}
