import type { TelemetryProcessType, TelemetryStatus } from "./telemetry-status";

/**
 * The complete allowlist of fields a telemetry lifecycle log line may carry.
 *
 * The type is closed for the same reason every other log allowlist in this
 * repository is, and the stakes are a little higher here: the values in scope
 * when telemetry starts are an OTLP endpoint and a header credential. Neither is
 * on this list, and widening it is the only way either could ever be printed.
 *
 * A line carries the process it belongs to, the stable status, and — for a
 * shutdown — how long it took. It never carries the endpoint, the headers, the
 * DSN, the sampling ratio's source, an exporter error, or a stack trace.
 */
export type TelemetryLogFields = Readonly<{
  processType: TelemetryProcessType;
  status: TelemetryStatus;
  durationMs?: number;
}>;

export type TelemetryLogInput = Readonly<{
  processType: TelemetryProcessType;
  status: TelemetryStatus;
  durationMs?: number | undefined;
}>;

export function toTelemetryLogFields(
  input: TelemetryLogInput,
): TelemetryLogFields {
  return {
    processType: input.processType,
    status: input.status,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  };
}

/** Stable, language-neutral event names for the telemetry lifecycle. */
export const TELEMETRY_LOG_EVENT = {
  STARTED: "telemetry.started",
  START_FAILED: "telemetry.start_failed",
  STOPPED: "telemetry.stopped",
} as const;

export type TelemetryLogEvent =
  (typeof TELEMETRY_LOG_EVENT)[keyof typeof TELEMETRY_LOG_EVENT];
