import "server-only";

import { serverEnv } from "@/config/env/index.server";

import {
  createApplicationLogger,
  type StructuredLogger,
} from "./create-logger.server";
import type { LogContext } from "./log-context";
import { getRequestContext } from "./request-context.server";

export const logger = createApplicationLogger({
  environment: serverEnv.APP_ENV,
});

export function createContextLogger(
  baseLogger: StructuredLogger,
  context: LogContext = {},
): StructuredLogger {
  const bindings = {
    ...context,
    ...getRequestContext(),
  };

  return Object.keys(bindings).length > 0
    ? baseLogger.child(bindings)
    : baseLogger;
}

export function getRequestLogger(context: LogContext = {}): StructuredLogger {
  return createContextLogger(logger, context);
}
