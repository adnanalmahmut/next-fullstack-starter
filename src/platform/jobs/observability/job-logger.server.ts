import "server-only";

import { logger } from "@/platform/observability/logger.server";

import { toJobLogFields, type JobLogInput } from "./job-log-fields";
import type { JobsLogEvent } from "./log-event";

/**
 * The one way a background-jobs line is written.
 *
 * Every call goes through `toJobLogFields`, so the allowlist is applied by
 * construction rather than by everybody remembering. Nothing in this area calls
 * `logger` directly, and a contract test holds that.
 *
 * There is no request context to inherit here — a worker is not serving a
 * request — so the correlation identifier travels in the envelope and is passed
 * in as a field like any other.
 */
export const JOB_LOG_LEVEL = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
} as const;

export type JobLogLevel = (typeof JOB_LOG_LEVEL)[keyof typeof JOB_LOG_LEVEL];

export function logJobEvent(
  level: JobLogLevel,
  event: JobsLogEvent,
  fields: JobLogInput = {},
): void {
  logger[level](toJobLogFields(fields), event);
}
