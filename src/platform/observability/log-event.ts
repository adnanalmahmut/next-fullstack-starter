export const LOG_EVENT = {
  APPLICATION_STARTED: "application.started",
  REQUEST_FAILED: "request.failed",
  OPERATION_STARTED: "operation.started",
  OPERATION_SUCCEEDED: "operation.succeeded",
  OPERATION_FAILED: "operation.failed",
  JOB_STARTED: "job.started",
  JOB_SUCCEEDED: "job.succeeded",
  JOB_FAILED: "job.failed",
} as const;

export type LogEvent = (typeof LOG_EVENT)[keyof typeof LOG_EVENT];
