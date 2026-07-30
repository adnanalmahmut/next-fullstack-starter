import "server-only";

import { LOG_EVENT } from "./log-event";
import { LOG_STATUS, type RequestContext } from "./log-context";
import { type StructuredLogger } from "./create-logger.server";
import { createContextLogger, logger } from "./logger.server";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id.server";
import { runWithRequestContext } from "./request-context.server";
import { isExpectedApplicationError, toSafeLogError } from "./safe-error";

type RequestErrorRequest = Readonly<{
  method: string;
  headers: Record<string, string | string[] | undefined>;
}>;

type RequestErrorContext = Readonly<{
  routerKind: "Pages Router" | "App Router";
  routePath: string;
  routeType: string;
}>;

function readHeader(
  headers: RequestErrorRequest["headers"],
  name: string,
): string | undefined {
  const entry = Object.entries(headers).find(
    ([headerName]) => headerName.toLowerCase() === name,
  );
  const value = entry?.[1];

  return typeof value === "string" ? value : undefined;
}

function reportRequestError(
  error: unknown,
  request: RequestErrorRequest,
  context: RequestErrorContext,
  baseLogger: StructuredLogger,
): void {
  const requestContext: RequestContext = {
    requestId: resolveRequestId(readHeader(request.headers, REQUEST_ID_HEADER)),
    route: context.routePath,
    method: request.method,
    routerKind: context.routerKind,
  };
  const safeError = toSafeLogError(error);

  runWithRequestContext(requestContext, () => {
    const requestLogger = createContextLogger(baseLogger, {
      operation: context.routeType,
      status: LOG_STATUS.FAILED,
      errorCode: safeError.errorCode,
    });
    const logRecord = {
      ...safeError,
      status: LOG_STATUS.FAILED,
    };

    if (isExpectedApplicationError(error)) {
      requestLogger.warn(logRecord, LOG_EVENT.REQUEST_FAILED);
      return;
    }

    requestLogger.error(logRecord, LOG_EVENT.REQUEST_FAILED);
  });
}

export function reportRequestErrorSafely(
  error: unknown,
  request: RequestErrorRequest,
  context: RequestErrorContext,
  baseLogger: StructuredLogger = logger,
): void {
  try {
    reportRequestError(error, request, context, baseLogger);
  } catch {
    return;
  }
}
