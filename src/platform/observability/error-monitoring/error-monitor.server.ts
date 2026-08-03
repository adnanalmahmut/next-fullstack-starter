import "server-only";

import type { StructuredLogger } from "../create-logger.server";
import { logger as rootLogger } from "../logger.server";
import {
  TELEMETRY_PROCESS_TYPE,
  type TelemetryProcessType,
} from "../telemetry/telemetry-status";
import { activeTraceLogFields } from "../trace-log-fields";

import {
  isReportableError,
  NOOP_ERROR_MONITOR,
  type ErrorCaptureContext,
  type ErrorMonitor,
} from "./error-monitor";
import {
  ERROR_MONITORING_STATUS,
  getErrorMonitoringConfiguration,
  type ErrorMonitoringStatus,
} from "./error-monitoring-config";

/**
 * The error-monitoring lifecycle for this process.
 *
 * It is the counterpart of the telemetry lifecycle and behaves the same way:
 * disabled by default, started once, contained on failure, and a no-op whenever it
 * is not actually running. A boundary calls `captureUnexpectedError` without
 * knowing or caring which of those is true.
 *
 * ## Why capture is synchronous and never awaited
 *
 * A capture happens on the failure path of a request, an action, or a job — the
 * path where something has already gone wrong and the caller is waiting for an
 * answer. Awaiting a network round trip to a vendor there would add the vendor's
 * latency, and its outages, to every failure this application reports. So capture
 * hands the error to an already-initialized client and returns; the client batches
 * and sends it on its own schedule, and a flush at shutdown is what makes the last
 * batch leave.
 *
 * The consequence is stated rather than hidden: an error captured before
 * initialization finishes, or after a shutdown, is dropped. Both windows are
 * narrow — `register()` awaits the start before the server is ready, and the
 * worker awaits it before consuming — and dropping a report is strictly better
 * than making a request wait on one.
 */
export type ErrorMonitorHandle = Readonly<{
  processType: TelemetryProcessType;
  status: ErrorMonitoringStatus;
}>;

export type StartErrorMonitorOptions = Readonly<{
  processType: TelemetryProcessType;
  /** Overridden only by tests that capture the lifecycle lines. */
  logger?: StructuredLogger;
}>;

/** Stable, language-neutral event names for the error-monitoring lifecycle. */
export const ERROR_MONITORING_LOG_EVENT = {
  STARTED: "error_monitoring.started",
  START_FAILED: "error_monitoring.start_failed",
  STOPPED: "error_monitoring.stopped",
} as const;

/**
 * The complete allowlist of fields an error-monitoring lifecycle line may carry.
 *
 * The DSN is not on it, and cannot be added without changing this type.
 */
export type ErrorMonitoringLogFields = Readonly<{
  processType: TelemetryProcessType;
  status: ErrorMonitoringStatus;
}>;

type ErrorMonitorState = {
  startup?: Promise<ErrorMonitorHandle>;
  monitor: ErrorMonitor;
  status: ErrorMonitoringStatus;
  processType: TelemetryProcessType;
  shutdown?: Promise<void>;
};

const globalForErrorMonitor = globalThis as typeof globalThis & {
  errorMonitorState?: ErrorMonitorState;
};

function state(): ErrorMonitorState {
  globalForErrorMonitor.errorMonitorState ??= {
    monitor: NOOP_ERROR_MONITOR,
    status: ERROR_MONITORING_STATUS.DISABLED,
    processType: TELEMETRY_PROCESS_TYPE.WEB,
  };

  return globalForErrorMonitor.errorMonitorState;
}

function logLifecycle(
  logger: StructuredLogger,
  event: (typeof ERROR_MONITORING_LOG_EVENT)[keyof typeof ERROR_MONITORING_LOG_EVENT],
  fields: ErrorMonitoringLogFields,
): void {
  try {
    if (event === ERROR_MONITORING_LOG_EVENT.START_FAILED) {
      logger.error(fields, event);

      return;
    }

    logger.info(fields, event);
  } catch {
    // A lifecycle line that cannot be written is not worth a failed startup.
  }
}

async function startOnce(
  options: StartErrorMonitorOptions,
): Promise<ErrorMonitorHandle> {
  const { processType } = options;
  const logger = options.logger ?? rootLogger;
  const configuration = getErrorMonitoringConfiguration();
  const current = state();

  current.processType = processType;
  current.shutdown = undefined;

  if (!configuration.enabled) {
    current.monitor = NOOP_ERROR_MONITOR;
    current.status = configuration.status;

    if (
      configuration.status === ERROR_MONITORING_STATUS.INVALID_CONFIGURATION
    ) {
      logLifecycle(logger, ERROR_MONITORING_LOG_EVENT.START_FAILED, {
        processType,
        status: configuration.status,
      });
    }

    return { processType, status: configuration.status };
  }

  try {
    // Dynamic, and inside the enabled branch: this is the line that decides
    // whether `@sentry/node` is ever evaluated in this process.
    const { createSentryErrorMonitor } =
      await import("./sentry-error-monitor.server");

    current.monitor = await createSentryErrorMonitor({
      configuration,
      processType,
      // The trace id comes from the active span and from nowhere else, so a
      // captured error can be joined to its trace without any client being able
      // to choose the trace it lands in.
      resolveTraceId: () => activeTraceLogFields().traceId,
    });
    current.status = ERROR_MONITORING_STATUS.STARTED;

    logLifecycle(logger, ERROR_MONITORING_LOG_EVENT.STARTED, {
      processType,
      status: current.status,
    });

    return { processType, status: current.status };
  } catch {
    // Nothing about the failure is reported beyond the status: the value in scope
    // is a DSN, and a provider error message is where it would appear.
    current.monitor = NOOP_ERROR_MONITOR;
    current.status = ERROR_MONITORING_STATUS.START_FAILED;
    // Cleared so one transient failure is not permanent for the life of the
    // process, and so the failure path stays testable.
    current.startup = undefined;

    logLifecycle(logger, ERROR_MONITORING_LOG_EVENT.START_FAILED, {
      processType,
      status: current.status,
    });

    return { processType, status: current.status };
  }
}

/**
 * Starts error monitoring for this process, at most once.
 *
 * Concurrent callers share one promise, so two boundaries racing at startup cannot
 * initialize two clients.
 */
export function startErrorMonitor(
  options: StartErrorMonitorOptions,
): Promise<ErrorMonitorHandle> {
  const current = state();

  return (current.startup ??= startOnce(options));
}

export function errorMonitorStatus(): ErrorMonitoringStatus {
  return state().status;
}

/**
 * Reports an unexpected failure, best effort.
 *
 * Expected refusals are filtered here rather than at each boundary, so "a
 * `FORBIDDEN` is never reported to a vendor" is one decision instead of five.
 * Nothing is thrown, nothing is awaited, and nothing about the caller's outcome
 * changes.
 */
export function captureUnexpectedError(
  error: unknown,
  context: ErrorCaptureContext,
): void {
  try {
    if (!isReportableError(error)) {
      return;
    }

    state().monitor.capture(error, context);
  } catch {
    // Reporting a failure must never become a second failure.
  }
}

/** Flushes pending reports within a bounded budget. Never throws. */
export async function flushErrorMonitor(timeoutMs: number): Promise<void> {
  try {
    await state().monitor.flush(timeoutMs);
  } catch {
    // A flush that failed is lost telemetry, not a failed shutdown.
  }
}

/**
 * Closes the client and returns to the no-op monitor.
 *
 * Idempotent: a second call joins the shutdown already in progress.
 */
export function shutdownErrorMonitor(): Promise<void> {
  const current = state();

  return (current.shutdown ??= (async () => {
    const monitor = current.monitor;
    const startedStatus = current.status;

    current.monitor = NOOP_ERROR_MONITOR;
    current.startup = undefined;

    try {
      await monitor.shutdown();
    } catch {
      // Closing a client cannot be allowed to change an exit code.
    }

    if (startedStatus === ERROR_MONITORING_STATUS.STARTED) {
      current.status = ERROR_MONITORING_STATUS.STOPPED;

      logLifecycle(rootLogger, ERROR_MONITORING_LOG_EVENT.STOPPED, {
        processType: current.processType,
        status: current.status,
      });
    }
  })());
}

/** Forgets the lifecycle state without closing anything. For tests. */
export function resetErrorMonitor(): void {
  globalForErrorMonitor.errorMonitorState = {
    monitor: NOOP_ERROR_MONITOR,
    status: ERROR_MONITORING_STATUS.DISABLED,
    processType: TELEMETRY_PROCESS_TYPE.WEB,
  };
}
