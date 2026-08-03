import "server-only";

import type { StructuredLogger } from "./create-logger.server";
import {
  startErrorMonitor,
  type ErrorMonitorHandle,
} from "./error-monitoring/error-monitor.server";
import { ERROR_MONITORING_STATUS } from "./error-monitoring/error-monitoring-config";
import { LOG_EVENT } from "./log-event";
import { logger } from "./logger.server";
import {
  startProductionTelemetry,
  type ProductionTelemetryHandle,
} from "./telemetry/telemetry-sdk.server";
import {
  TELEMETRY_PROCESS_TYPE,
  TELEMETRY_STATUS,
} from "./telemetry/telemetry-status";

/**
 * What a Node server instance does once, before it is ready to serve.
 *
 * It is called from `src/instrumentation.ts`, which is the only place Next.js
 * offers for work that must complete before the first request. Three things happen
 * here, in this order, and the order is the whole design:
 *
 * 1. `application.started` is logged. It is the one line that must appear even
 *    when everything optional is switched off, so it comes first and nothing can
 *    delay it.
 * 2. Telemetry is started. With `TELEMETRY_ENABLED=false` this loads no SDK and
 *    returns immediately; with it enabled the providers are registered *before*
 *    the server accepts a request, so the first request is traced rather than
 *    silently dropped into a provider that does not exist yet.
 * 3. Error monitoring is started, on its own switch, for the same reason: a client
 *    that finished initializing after the first failure would miss it.
 *
 * Neither optional area can prevent startup. Both start functions contain their own
 * failures and answer with a stable status rather than throwing, and the `catch`
 * below is a second guard rather than the first: an application that refused to
 * boot because a collector was unreachable would have made observability a
 * correctness dependency, which is precisely backwards.
 *
 * The returned promise is shared, so a second `register()` — a reload, a second
 * server instance in the same process — joins the first rather than logging the
 * startup event twice or registering a second SDK.
 */
export type ObservabilityRegistration = Readonly<{
  telemetry: ProductionTelemetryHandle;
  errorMonitoring: ErrorMonitorHandle;
}>;

let registration: Promise<ObservabilityRegistration> | undefined;

async function register(
  baseLogger: StructuredLogger,
): Promise<ObservabilityRegistration> {
  baseLogger.info(LOG_EVENT.APPLICATION_STARTED);

  const processType = TELEMETRY_PROCESS_TYPE.WEB;

  const telemetry = await startProductionTelemetry({
    processType,
    logger: baseLogger,
  });
  const errorMonitoring = await startErrorMonitor({
    processType,
    logger: baseLogger,
  });

  return { telemetry, errorMonitoring };
}

export function registerObservability(
  baseLogger: StructuredLogger = logger,
): Promise<ObservabilityRegistration> {
  return (registration ??= register(baseLogger).catch(() => ({
    // Unreachable through either start function, which never reject. It is here so
    // that a future change inside one of them cannot turn a telemetry problem into
    // a server that will not start.
    telemetry: {
      processType: TELEMETRY_PROCESS_TYPE.WEB,
      status: TELEMETRY_STATUS.START_FAILED,
    },
    errorMonitoring: {
      processType: TELEMETRY_PROCESS_TYPE.WEB,
      status: ERROR_MONITORING_STATUS.START_FAILED,
    },
  })));
}

/** Forgets the registration so the next call runs again. For tests. */
export function resetObservabilityRegistration(): void {
  registration = undefined;
}
