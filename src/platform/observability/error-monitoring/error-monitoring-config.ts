import { serverEnv } from "@/config/env/index.server";
import { readErrorMonitoringEnvironment } from "@/config/env/read-error-monitoring";
import type { ErrorMonitoringEnvironment } from "@/config/env/schema";

/**
 * The lazy, cached error-monitoring configuration.
 *
 * Read lazily and never at import time, for the same reasons the telemetry
 * configuration is: importing this module reads no variable, holds no DSN, and
 * contacts nothing. And like that one it never throws — a malformed DSN must not
 * take a web process or a worker down, so it resolves to a disabled configuration
 * and the application reports its errors to its logs, which is where they already
 * are.
 *
 * It is a separate configuration from telemetry's, and the separation is the
 * contract: `TELEMETRY_ENABLED` decides whether traces and metrics reach a
 * collector, `ERROR_MONITORING_ENABLED` decides whether unexpected failures reach
 * a vendor, and neither may switch the other off.
 */
export const ERROR_MONITORING_STATUS = {
  DISABLED: "disabled",
  INVALID_CONFIGURATION: "invalid-configuration",
  STARTED: "started",
  START_FAILED: "start-failed",
  STOPPED: "stopped",
} as const;

export type ErrorMonitoringStatus =
  (typeof ERROR_MONITORING_STATUS)[keyof typeof ERROR_MONITORING_STATUS];

export type ErrorMonitoringConfiguration =
  | Readonly<{
      enabled: false;
      status: Extract<
        ErrorMonitoringStatus,
        "disabled" | "invalid-configuration"
      >;
    }>
  | Readonly<{
      enabled: true;
      /** A credential. Never logged, never reported, never serialized. */
      dsn: string;
      environment: string;
      release: string | undefined;
    }>;

type ErrorMonitoringConfigurationState = {
  configuration?: ErrorMonitoringConfiguration;
};

const globalForErrorMonitoringConfiguration =
  globalThis as typeof globalThis & {
    errorMonitoringConfigurationState?: ErrorMonitoringConfigurationState;
  };

function state(): ErrorMonitoringConfigurationState {
  globalForErrorMonitoringConfiguration.errorMonitoringConfigurationState ??=
    {};

  return globalForErrorMonitoringConfiguration.errorMonitoringConfigurationState;
}

function resolveConfiguration(): ErrorMonitoringConfiguration {
  let environment: ErrorMonitoringEnvironment;

  try {
    environment = readErrorMonitoringEnvironment();
  } catch {
    // The thrown message names the failing variable, and the failing variable is
    // usually the DSN. The status is the whole report.
    return {
      enabled: false,
      status: ERROR_MONITORING_STATUS.INVALID_CONFIGURATION,
    };
  }

  if (!environment.ERROR_MONITORING_ENABLED) {
    return { enabled: false, status: ERROR_MONITORING_STATUS.DISABLED };
  }

  const dsn = environment.SENTRY_DSN;

  if (dsn === undefined) {
    return {
      enabled: false,
      status: ERROR_MONITORING_STATUS.INVALID_CONFIGURATION,
    };
  }

  return {
    enabled: true,
    dsn,
    environment: serverEnv.APP_ENV,
    release: environment.APP_RELEASE,
  };
}

export function getErrorMonitoringConfiguration(): ErrorMonitoringConfiguration {
  const current = state();

  current.configuration ??= resolveConfiguration();

  return current.configuration;
}

export function isErrorMonitoringEnabled(): boolean {
  return getErrorMonitoringConfiguration().enabled;
}

/** Forgets the cached configuration. For tests and for an explicit restart. */
export function resetErrorMonitoringConfiguration(): void {
  state().configuration = undefined;
}
