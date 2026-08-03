import "server-only";

import type { TelemetryProcessType } from "../telemetry/telemetry-status";

import type { ErrorCaptureContext, ErrorMonitor } from "./error-monitor";
import type { ErrorMonitoringConfiguration } from "./error-monitoring-config";
import {
  sanitizeSentryEvent,
  type IncomingSentryEvent,
} from "./sentry-event-policy";

/**
 * The Sentry adapter, and the only file in this repository that touches
 * `@sentry/node`.
 *
 * The import is dynamic and lives inside the enabled branch, exactly as the
 * OpenTelemetry SDK's is, and for the same reasons: with
 * `ERROR_MONITORING_ENABLED=false` the SDK is never evaluated, so there is no
 * client, no transport, no flush timer, no DSN in memory, and no socket. A DSN is
 * never required to build, to run `pnpm verify`, or to pass the end-to-end suite.
 *
 * ## What is switched off, and why
 *
 * The decision recorded in `docs/adr/0002-server-error-monitoring.md`
 * is that Sentry reports unexpected failures and does nothing else. Traces and
 * metrics belong to OpenTelemetry over OTLP, and logs belong to Pino. Three
 * options enforce that here:
 *
 * - `tracesSampleRate: 0` — no performance data is produced at all.
 * - `skipOpenTelemetrySetup: true` — this is the important one. Since v8 the
 *   Node SDK is built on OpenTelemetry and, left to itself, installs its own
 *   span processor, propagator, sampler, and **context manager** into the global
 *   OpenTelemetry API. In a process that has already registered its own providers
 *   that is not an addition, it is a replacement: every span this application
 *   creates would be routed through Sentry instead of to the collector, and the
 *   propagator swap would change the wire format the outbox stores.
 * - `defaultIntegrations: false` with an empty `integrations` array — no automatic
 *   HTTP or database instrumentation, no console breadcrumbs, no request-data
 *   capture, no local-variable capture, no module inventory, and no
 *   process-wide `uncaughtException` or `unhandledRejection` handler. A platform
 *   module must not install a process handler on every host that imports it.
 *
 * `registerEsmLoaderHooks: false` for the same reason as the integrations: hooking
 * the ESM loader to instrument libraries is auto-instrumentation by another route.
 *
 * Nothing is sent that `sanitizeSentryEvent` did not rebuild, and `beforeSend` is
 * where that is enforced — after the SDK has attached the host name, the runtime
 * context, and the module list, so all three are dropped rather than merely
 * never set.
 */
type SentryModule = typeof import("@sentry/node");

type EnabledErrorMonitoringConfiguration = Extract<
  ErrorMonitoringConfiguration,
  { enabled: true }
>;

/** The ceiling on a flush. A dying process must not wait on a vendor's socket. */
export const SENTRY_FLUSH_TIMEOUT_MS = 2_000;

function toTagValue(value: string | number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

/**
 * The tags a capture may set, built from the closed capture context.
 *
 * Building the map here rather than accepting one is what keeps the tag
 * vocabulary closed: `sanitizeSentryEvent` drops any tag it does not recognise,
 * and this function is the only thing that ever sets one.
 */
function captureTags(
  context: ErrorCaptureContext,
  processType: TelemetryProcessType,
  traceId: string | undefined,
): Readonly<Record<string, string>> {
  const tags: Record<string, string> = {
    boundary: context.boundary,
    process_type: processType,
  };

  const entries: readonly (readonly [string, string | undefined])[] = [
    ["operation_name", context.operationName],
    ["error_code", context.errorCode],
    ["request_id", context.requestId],
    ["trace_id", traceId],
    ["job_name", context.jobName],
    ["job_version", toTagValue(context.jobVersion)],
  ];

  for (const [name, value] of entries) {
    if (value !== undefined) {
      tags[name] = value;
    }
  }

  return tags;
}

export type CreateSentryErrorMonitorOptions = Readonly<{
  configuration: EnabledErrorMonitoringConfiguration;
  processType: TelemetryProcessType;
  /** The active trace id, when there is one. Read from the span, never a client. */
  resolveTraceId: () => string | undefined;
}>;

export async function createSentryErrorMonitor(
  options: CreateSentryErrorMonitorOptions,
): Promise<ErrorMonitor> {
  const { configuration, processType, resolveTraceId } = options;
  const Sentry: SentryModule = await import("@sentry/node");

  Sentry.init({
    dsn: configuration.dsn,
    environment: configuration.environment,
    ...(configuration.release === undefined
      ? {}
      : { release: configuration.release }),

    tracesSampleRate: 0,
    skipOpenTelemetrySetup: true,

    defaultIntegrations: false,
    integrations: [],
    registerEsmLoaderHooks: false,

    includeLocalVariables: false,
    sendDefaultPii: false,
    attachStacktrace: true,
    maxBreadcrumbs: 0,

    beforeBreadcrumb: () => null,
    // Nothing should reach this with `tracesSampleRate: 0`; refusing anyway means
    // a future option change cannot quietly start sending performance data.
    beforeSendTransaction: () => null,

    // The single enforcement point. The event the SDK built is discarded and a new
    // one is assembled from the allowlist; the cast is the one place a vendor type
    // meets this repository's own, and it is deliberately narrow.
    beforeSend: (event) =>
      sanitizeSentryEvent(
        event as IncomingSentryEvent,
      ) as unknown as typeof event,
  });

  return {
    capture: (error, context) => {
      try {
        const tags = captureTags(context, processType, resolveTraceId());

        Sentry.withScope((scope) => {
          scope.setLevel("error");

          for (const [name, value] of Object.entries(tags)) {
            scope.setTag(name, value);
          }

          Sentry.captureException(error);
        });
      } catch {
        // Reporting a failure must never become a second failure. There is
        // nothing useful to do with a provider error here, and the original error
        // has already been logged by the boundary that caught it.
      }
    },
    flush: async (timeoutMs: number) => {
      try {
        await Sentry.flush(timeoutMs);
      } catch {
        // A flush that failed is lost telemetry, not a failed shutdown.
      }
    },
    shutdown: async () => {
      try {
        await Sentry.close(SENTRY_FLUSH_TIMEOUT_MS);
      } catch {
        // Same: closing the client cannot be allowed to change an exit code.
      }
    },
  };
}
