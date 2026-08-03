import type { ErrorCode } from "@/shared/errors/error-code";

export const LOG_STATUS = {
  STARTED: "started",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
} as const;

export type LogStatus = (typeof LOG_STATUS)[keyof typeof LOG_STATUS];

export type LogContext = Readonly<{
  requestId?: string;
  jobId?: string;
  userId?: string;
  actorType?: "user" | "system" | "service";
  organizationId?: string;
  module?: string;
  operation?: string;
  route?: string;
  method?: string;
  routerKind?: "App Router" | "Pages Router";
  locale?: string;
  durationMs?: number;
  status?: LogStatus;
  errorCode?: ErrorCode;
  /**
   * Trace correlation, derived from the active span and from nothing else.
   *
   * The three fields are optional and are absent whenever no OpenTelemetry SDK is
   * registered, which is the default. They are never accepted from a client, a
   * header, or a payload: a caller must not be able to choose the trace its log
   * line claims to belong to. The assembled `traceparent`, `tracestate`, and
   * baggage are all deliberately absent — a log line carries identifiers, not a
   * propagation wire format.
   */
  traceId?: string;
  spanId?: string;
  traceFlags?: string;
}>;

export type RequestContext = Readonly<
  LogContext & {
    requestId: string;
  }
>;
