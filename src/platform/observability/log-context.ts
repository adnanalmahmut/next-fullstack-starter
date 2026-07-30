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
}>;

export type RequestContext = Readonly<
  LogContext & {
    requestId: string;
  }
>;
