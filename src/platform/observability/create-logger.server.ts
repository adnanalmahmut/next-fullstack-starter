import "server-only";

import pino, {
  type DestinationStream,
  type LevelWithSilent,
  type LogFn,
} from "pino";

import type { ServerEnvironment } from "@/config/env/schema";

import type { LogContext } from "./log-context";
import { SENSITIVE_LOG_PATHS } from "./redaction";
import { toSafeLogError } from "./safe-error";

export type StructuredLogger = Readonly<{
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  child(bindings: LogContext): StructuredLogger;
}>;

type CreateLoggerOptions = Readonly<{
  environment: ServerEnvironment["APP_ENV"];
  level?: LevelWithSilent;
  destination?: DestinationStream;
}>;

export function defaultLogLevel(
  environment: ServerEnvironment["APP_ENV"],
): LevelWithSilent {
  if (environment === "test") {
    return "silent";
  }

  return environment === "development" ? "debug" : "info";
}

export function createApplicationLogger({
  environment,
  level = defaultLogLevel(environment),
  destination,
}: CreateLoggerOptions): StructuredLogger {
  const options = {
    base: {
      service: "next-fullstack-starter",
      environment,
    },
    level,
    redact: {
      paths: [...SENSITIVE_LOG_PATHS],
      remove: true,
    },
    serializers: {
      err: toSafeLogError,
      error: toSafeLogError,
    },
  };

  const instance = destination ? pino(options, destination) : pino(options);

  return instance as unknown as StructuredLogger;
}
