import "server-only";

import { logger } from "@/platform/observability/logger.server";

import { toHealthLogFields, type HealthLogInput } from "./health-log-fields";
import type { HealthLogEvent } from "./log-event";

/**
 * The one way a health line is written.
 *
 * Every call goes through `toHealthLogFields`, so the allowlist is applied by
 * construction rather than by everybody remembering it. Nothing else in this
 * directory calls `logger` directly, and a contract test holds that line — the
 * moment one file does, the allowlist stops being a guarantee and becomes a
 * convention.
 *
 * `console` is not used anywhere here, including in the worker command. A
 * structured line goes through the same redaction and the same transport as
 * every other line in the application, whereas a `console.log` is raw text on a
 * terminal that gets pasted into an issue.
 *
 * There is no request context to inherit: a readiness probe is not a business
 * request and a worker check is not a request at all, so nothing correlates and
 * nothing pretends to.
 */
export const HEALTH_LOG_LEVEL = {
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
} as const;

export type HealthLogLevel =
  (typeof HEALTH_LOG_LEVEL)[keyof typeof HEALTH_LOG_LEVEL];

export function logHealthEvent(
  level: HealthLogLevel,
  event: HealthLogEvent,
  fields: HealthLogInput = {},
): void {
  logger[level](toHealthLogFields(fields), event);
}
