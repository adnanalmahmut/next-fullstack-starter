import "server-only";

export { LOG_EVENT } from "./log-event";
export {
  LOG_STATUS,
  type LogContext,
  type RequestContext,
} from "./log-context";
export { getRequestLogger, logger } from "./logger.server";
export {
  type OperationTimer,
  startOperationTimer,
} from "./operation-timer.server";
export {
  getRequestContext,
  requireRequestContext,
  runWithRequestContext,
} from "./request-context.server";
export {
  isValidRequestId,
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "./request-id.server";
export {
  LOG_ERROR_TYPE,
  type SafeLogError,
  toSafeLogError,
} from "./safe-error";

/**
 * The tracing contract.
 *
 * Every call site — a route, an action, a job, a repository, a storage adapter —
 * traces through these functions and never through an OpenTelemetry SDK. That is
 * what keeps the SDK inside two files and what makes every span a no-op, rather
 * than an error, on a deployment with no collector.
 */
export {
  currentTraceContext,
  runWithRemoteTraceContext,
  setSpanOutcomeSafely,
  SPAN_ATTRIBUTE,
  SPAN_OUTCOME,
  withActiveSpan,
  type SpanAttributes,
  type SpanAttributeValue,
  type SpanOutcome,
  type SpanRecorder,
} from "./tracing.server";

export {
  isValidTraceparent,
  isValidTracestate,
  MAX_TRACESTATE_LENGTH,
  sanitizeTraceContext,
  traceContextSchema,
  type TraceContext,
} from "./trace-context";

export { activeTraceLogFields, type TraceLogFields } from "./trace-log-fields";

/**
 * The closed database-operation span registry.
 *
 * There is deliberately no way to name a span after a table, a statement, or a
 * record: the operation is a member of `DATABASE_OPERATION` or it is nothing.
 */
export {
  DATABASE_OPERATION,
  DATABASE_OPERATIONS,
  DATABASE_SPAN_ATTRIBUTE,
  withDatabaseOperationSpan,
  type DatabaseOperation,
} from "./database-span.server";

/**
 * The closed metric registry and its typed recorders.
 *
 * No `recordMetric(name, value)` is exported, and no recorder accepts an open
 * attribute map, so neither a metric name nor a metric dimension can be invented
 * at a call site.
 */
export {
  METRIC,
  METRIC_NAMES,
  MAX_METRIC_OBSERVER_BUDGET_MS,
  OUTBOX_BACKLOG_STATE,
  recordActionExecution,
  recordJobDeadLettered,
  recordJobExecution,
  recordJobRetry,
  recordOutboxDeadLettered,
  recordOutboxPublish,
  recordOutboxPublishRetry,
  recordRouteRequest,
  recordStorageFailure,
  registerOutboxBacklogObserver,
  resetTelemetryInstruments,
  type ActionMetricFields,
  type JobIdentityFields,
  type JobMetricFields,
  type MetricName,
  type MetricObserverRegistration,
  type OutboxBacklogObserver,
  type OutboxBacklogSnapshot,
  type RouteMetricFields,
  type StorageFailureMetricFields,
} from "./metrics.server";

/**
 * The telemetry lifecycle.
 *
 * `startProductionTelemetry` is the only function that ever loads an OpenTelemetry
 * SDK, and it loads one only when telemetry is enabled and configured.
 */
export {
  forceFlushProductionTelemetry,
  productionTelemetryStatus,
  resetProductionTelemetry,
  shutdownProductionTelemetry,
  startProductionTelemetry,
  TELEMETRY_SHUTDOWN_TIMEOUT_MS,
  type ProductionTelemetryHandle,
  type StartProductionTelemetryOptions,
} from "./telemetry/telemetry-sdk.server";

export {
  getTelemetryConfiguration,
  isTelemetryEnabled,
  resetTelemetryConfiguration,
  TELEMETRY_SERVICE_NAME,
  type TelemetryConfiguration,
} from "./telemetry/telemetry-config";

export {
  isTelemetryActive,
  TELEMETRY_PROCESS_TYPE,
  TELEMETRY_STATUS,
  type TelemetryProcessType,
  type TelemetryStatus,
} from "./telemetry/telemetry-status";

export {
  TELEMETRY_LOG_EVENT,
  toTelemetryLogFields,
  type TelemetryLogEvent,
  type TelemetryLogFields,
} from "./telemetry/telemetry-log-fields";

/**
 * Server-side error monitoring, through a provider-neutral port.
 *
 * The Sentry adapter is not exported and cannot be reached from here: a boundary
 * captures through `captureUnexpectedError` and never through a vendor SDK.
 */
export {
  captureUnexpectedError,
  ERROR_MONITORING_LOG_EVENT,
  errorMonitorStatus,
  flushErrorMonitor,
  resetErrorMonitor,
  shutdownErrorMonitor,
  startErrorMonitor,
  type ErrorMonitorHandle,
  type ErrorMonitoringLogFields,
  type StartErrorMonitorOptions,
} from "./error-monitoring/error-monitor.server";

export {
  ERROR_BOUNDARY,
  EXPECTED_ERROR_CODES,
  isReportableError,
  NOOP_ERROR_MONITOR,
  type ErrorBoundary,
  type ErrorCaptureContext,
  type ErrorMonitor,
} from "./error-monitoring/error-monitor";

export {
  ERROR_MONITORING_STATUS,
  getErrorMonitoringConfiguration,
  isErrorMonitoringEnabled,
  resetErrorMonitoringConfiguration,
  type ErrorMonitoringConfiguration,
  type ErrorMonitoringStatus,
} from "./error-monitoring/error-monitoring-config";
