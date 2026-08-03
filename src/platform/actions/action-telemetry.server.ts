import "server-only";

import {
  captureUnexpectedError,
  ERROR_BOUNDARY,
  recordActionExecution,
  SPAN_OUTCOME,
  startOperationTimer,
  withActiveSpan,
  type SpanOutcome,
} from "@/platform/observability/index.server";
import { ERROR_CODE, type ErrorCode } from "@/shared/errors/error-code";

/**
 * The Server Action boundary's span and metrics, in one place.
 *
 * `defineAction` wraps every Server Action, so instrumenting it once here is what
 * makes every action traced and measured without a single action file mentioning
 * telemetry.
 *
 * The identity is `definition.name` — a stable, declared identifier — and nothing
 * else. A Server Action's argument is the richest untrusted value in the
 * application: it arrives from the browser, it is whatever the form held, and it is
 * therefore absent from the span and from the metric, along with the output, the
 * actor, the user id, the email address, the validated field names, and every error
 * message.
 *
 * Exactly one measurement per execution, recorded in `finally` from the outcome the
 * body reported — the same argument as the route boundary. And nothing here can
 * change an `ActionResult`: the wrapped body's return value is passed through
 * untouched, and every telemetry call is contained.
 */
export const ACTION_SPAN_ATTRIBUTE = {
  OPERATION_NAME: "app.operation.name",
  OPERATION_TYPE: "app.operation.type",
} as const;

export const ACTION_OPERATION_TYPE = "server_action";

export type ActionTelemetryReporter = Readonly<{
  report: (outcome: SpanOutcome, errorCode?: ErrorCode) => void;
  captureFailure: (error: unknown, errorCode: ErrorCode) => void;
}>;

export async function withActionTelemetry<T>(
  actionName: string,
  requestId: string | undefined,
  run: (telemetry: ActionTelemetryReporter) => Promise<T>,
): Promise<T> {
  const timer = startOperationTimer();

  let outcome: SpanOutcome = SPAN_OUTCOME.FAILED;
  let errorCode: ErrorCode | undefined = ERROR_CODE.INTERNAL_ERROR;

  return withActiveSpan(
    `${ACTION_OPERATION_TYPE}.${actionName}`,
    {
      [ACTION_SPAN_ATTRIBUTE.OPERATION_NAME]: actionName,
      [ACTION_SPAN_ATTRIBUTE.OPERATION_TYPE]: ACTION_OPERATION_TYPE,
    },
    async (span) => {
      try {
        return await run({
          report: (reportedOutcome, reportedErrorCode) => {
            outcome = reportedOutcome;
            errorCode = reportedErrorCode;
          },
          captureFailure: (error, failureCode) => {
            captureUnexpectedError(error, {
              boundary: ERROR_BOUNDARY.SERVER_ACTION,
              operationName: actionName,
              errorCode: failureCode,
              ...(requestId === undefined ? {} : { requestId }),
            });
          },
        });
      } finally {
        span.setOutcome(outcome, errorCode);

        recordActionExecution({
          actionName,
          outcome,
          errorCode,
          durationMs: timer.elapsedMs(),
        });
      }
    },
  );
}
