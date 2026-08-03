import { serverEnv } from "@/config/env/index.server";
import { parseOtlpHeaders, type OtlpHeaders } from "@/config/env/otlp-headers";
import { readTelemetryEnvironment } from "@/config/env/read-telemetry";
import {
  DEFAULT_PRODUCTION_TELEMETRY_TRACE_SAMPLE_RATIO,
  DEFAULT_TELEMETRY_TRACE_SAMPLE_RATIO,
  type TelemetryEnvironment,
} from "@/config/env/schema";

import { TELEMETRY_STATUS, type TelemetryStatus } from "./telemetry-status";

/**
 * The lazy, cached telemetry configuration.
 *
 * Two properties matter more than the shape:
 *
 * - **It is never read at import time.** Importing this module reads no variable,
 *   builds no exporter, and resolves no hostname. The first caller that genuinely
 *   needs to know whether telemetry is on pays for the parse, and a process that
 *   never asks never touches the environment at all.
 * - **It never throws.** Every other configuration in this repository refuses to
 *   start when it is malformed, and that is right for a database URL: an
 *   application with no database is not an application. Telemetry is the
 *   opposite. A mistyped endpoint or a mangled header list must not take a web
 *   process, a worker, a request, or a job down with it, so an invalid
 *   configuration resolves to a *disabled* configuration carrying a stable
 *   status, and the process runs as a no-op.
 *
 * The service name is fixed rather than configurable. It is the same value the
 * structured logger already stamps on every line, and two names for one service
 * would make a trace and its logs impossible to join.
 */
export const TELEMETRY_SERVICE_NAME = "next-fullstack-starter";

/** The path segments the OTLP/HTTP specification defines for each signal. */
const OTLP_TRACES_PATH = "v1/traces";
const OTLP_METRICS_PATH = "v1/metrics";

export type TelemetryConfiguration =
  | Readonly<{
      enabled: false;
      /** `disabled` or `invalid-configuration`; never a reason derived from input. */
      status: Extract<TelemetryStatus, "disabled" | "invalid-configuration">;
    }>
  | Readonly<{
      enabled: true;
      serviceName: string;
      /** Present only when `APP_RELEASE` is set. */
      serviceVersion: string | undefined;
      environment: string;
      /** Absolute OTLP/HTTP signal URLs, derived once from the base endpoint. */
      traceEndpoint: string;
      metricEndpoint: string;
      /** A credential. Never logged, never serialized, never reported. */
      headers: OtlpHeaders | undefined;
      traceSampleRatio: number;
      metricExportIntervalMs: number;
      exportTimeoutMs: number;
    }>;

type TelemetryConfigurationState = {
  configuration?: TelemetryConfiguration;
};

/**
 * Held on `globalThis` for the same reason the Prisma client and the storage
 * provider are: a development reload re-evaluates the module, and re-parsing on
 * every reload would be re-reading a credential on every reload.
 */
const globalForTelemetryConfiguration = globalThis as typeof globalThis & {
  telemetryConfigurationState?: TelemetryConfigurationState;
};

function state(): TelemetryConfigurationState {
  globalForTelemetryConfiguration.telemetryConfigurationState ??= {};

  return globalForTelemetryConfiguration.telemetryConfigurationState;
}

/**
 * Joins the base endpoint and a signal path.
 *
 * The exporter would otherwise fall back to its own `localhost:4318` default when
 * no URL is given, which is precisely the silent fallback this area refuses to
 * have. Building both URLs here means the exporter is always constructed with an
 * explicit address.
 */
function signalEndpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path}`;
}

function defaultTraceSampleRatio(
  environment: (typeof serverEnv)["APP_ENV"],
): number {
  return environment === "production"
    ? DEFAULT_PRODUCTION_TELEMETRY_TRACE_SAMPLE_RATIO
    : DEFAULT_TELEMETRY_TRACE_SAMPLE_RATIO;
}

function resolveTelemetryConfiguration(): TelemetryConfiguration {
  let environment: TelemetryEnvironment;

  try {
    environment = readTelemetryEnvironment();
  } catch {
    // The thrown message names the variables that failed, which is useful at a
    // terminal and unacceptable in a process that keeps serving traffic: it would
    // travel into a log line, and one of those variables is a credential. The
    // status is the whole report.
    return { enabled: false, status: TELEMETRY_STATUS.INVALID_CONFIGURATION };
  }

  if (!environment.TELEMETRY_ENABLED) {
    return { enabled: false, status: TELEMETRY_STATUS.DISABLED };
  }

  const endpoint = environment.TELEMETRY_OTLP_ENDPOINT;

  // The schema already requires it, so this is unreachable through the schema —
  // it is here because "enabled with no endpoint" must be an invalid
  // configuration rather than a type assertion, whichever way the value arrived.
  if (endpoint === undefined) {
    return { enabled: false, status: TELEMETRY_STATUS.INVALID_CONFIGURATION };
  }

  const rawHeaders = environment.TELEMETRY_OTLP_HEADERS;
  const headers =
    rawHeaders === undefined
      ? undefined
      : (parseOtlpHeaders(rawHeaders) ?? null);

  if (headers === null) {
    return { enabled: false, status: TELEMETRY_STATUS.INVALID_CONFIGURATION };
  }

  return {
    enabled: true,
    serviceName: TELEMETRY_SERVICE_NAME,
    serviceVersion: environment.APP_RELEASE,
    environment: serverEnv.APP_ENV,
    traceEndpoint: signalEndpoint(endpoint, OTLP_TRACES_PATH),
    metricEndpoint: signalEndpoint(endpoint, OTLP_METRICS_PATH),
    headers,
    traceSampleRatio:
      environment.TELEMETRY_TRACE_SAMPLE_RATIO ??
      defaultTraceSampleRatio(serverEnv.APP_ENV),
    metricExportIntervalMs: environment.TELEMETRY_METRIC_EXPORT_INTERVAL_MS,
    exportTimeoutMs: environment.TELEMETRY_EXPORT_TIMEOUT_MS,
  };
}

export function getTelemetryConfiguration(): TelemetryConfiguration {
  const current = state();

  current.configuration ??= resolveTelemetryConfiguration();

  return current.configuration;
}

/**
 * Whether telemetry is configured to export.
 *
 * `false` covers both "switched off" and "asked for but unusable", because from
 * every call site's point of view those are the same fact: there is nothing to
 * export to and nothing must change because of it.
 */
export function isTelemetryEnabled(): boolean {
  return getTelemetryConfiguration().enabled;
}

/** Forgets the cached configuration. For tests and for an explicit restart. */
export function resetTelemetryConfiguration(): void {
  state().configuration = undefined;
}
