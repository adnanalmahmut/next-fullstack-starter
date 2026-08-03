import "server-only";

import { serverEnv } from "@/config/env/index.server";

import {
  createApplicationLogger,
  type StructuredLogger,
} from "./create-logger.server";
import type { LogContext } from "./log-context";
import { getRequestContext } from "./request-context.server";
import { activeTraceLogFields } from "./trace-log-fields";

export const logger = createApplicationLogger({
  environment: serverEnv.APP_ENV,
});

/**
 * Binds the ambient context onto a logger.
 *
 * The order is deliberate: the caller's own fields first, then the request scope,
 * then the trace correlation. The request scope wins over a caller that tried to
 * name a different request id, and the trace fields win over everything, because
 * they are the only three that are read from process state a caller cannot reach.
 *
 * Trace correlation is added only when a valid span is active, so with no SDK
 * registered — the default — the bindings are byte for byte what they were before
 * tracing existed, and every existing log assertion still holds.
 */
export function createContextLogger(
  baseLogger: StructuredLogger,
  context: LogContext = {},
): StructuredLogger {
  const bindings = {
    ...context,
    ...getRequestContext(),
    ...activeTraceLogFields(),
  };

  return Object.keys(bindings).length > 0
    ? baseLogger.child(bindings)
    : baseLogger;
}

export function getRequestLogger(context: LogContext = {}): StructuredLogger {
  return createContextLogger(logger, context);
}
