/**
 * The closed set of answers to "what is telemetry doing in this process?".
 *
 * Every value is a stable, language-neutral identifier that is safe to log. None
 * of them carries a reason derived from a configuration value, an exporter error,
 * a hostname, or a credential — the whole point of a status code here is that the
 * one thing worth reporting about a failed telemetry start is *that it failed*,
 * and the diagnosis belongs to the operator's own collector logs rather than to
 * this application's output.
 */
export const TELEMETRY_STATUS = {
  /** `TELEMETRY_ENABLED` is false. Nothing was imported and nothing was built. */
  DISABLED: "disabled",
  /**
   * Telemetry was asked for, but the configuration cannot produce an exporter —
   * a missing endpoint, a malformed one, a credential inside the URL, an
   * unparseable header list. The process keeps running as a no-op.
   */
  INVALID_CONFIGURATION: "invalid-configuration",
  /** The providers are registered and exporting. */
  STARTED: "started",
  /**
   * The configuration was valid but the SDK could not be brought up. The process
   * keeps running as a no-op; it is never a startup failure.
   */
  START_FAILED: "start-failed",
  /** Shut down: every provider, reader, timer, and exporter has been released. */
  STOPPED: "stopped",
} as const;

export type TelemetryStatus =
  (typeof TELEMETRY_STATUS)[keyof typeof TELEMETRY_STATUS];

/**
 * The two processes that may carry telemetry.
 *
 * The set is closed because it becomes a resource attribute on every span and
 * every metric: an open string would be a cardinality decision made by whoever
 * called `start` next.
 */
export const TELEMETRY_PROCESS_TYPE = {
  WEB: "web",
  WORKER: "worker",
} as const;

export type TelemetryProcessType =
  (typeof TELEMETRY_PROCESS_TYPE)[keyof typeof TELEMETRY_PROCESS_TYPE];

/** Whether a status means spans and metrics are actually being exported. */
export function isTelemetryActive(status: TelemetryStatus): boolean {
  return status === TELEMETRY_STATUS.STARTED;
}
