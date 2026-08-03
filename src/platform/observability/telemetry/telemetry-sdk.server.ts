import "server-only";

import {
  context as otelContext,
  metrics as otelMetrics,
  propagation,
  trace,
} from "@opentelemetry/api";

import type { StructuredLogger } from "../create-logger.server";
import { logger as rootLogger } from "../logger.server";
import { resetTelemetryInstruments } from "../metrics.server";
import { startOperationTimer } from "../operation-timer.server";

import {
  getTelemetryConfiguration,
  type TelemetryConfiguration,
} from "./telemetry-config";
import {
  TELEMETRY_LOG_EVENT,
  toTelemetryLogFields,
} from "./telemetry-log-fields";
import {
  TELEMETRY_PROCESS_TYPE,
  TELEMETRY_STATUS,
  type TelemetryProcessType,
  type TelemetryStatus,
} from "./telemetry-status";

/**
 * The OpenTelemetry SDK lifecycle, and the only file in this repository that
 * touches an SDK package.
 *
 * ## Why every SDK import is dynamic
 *
 * Nothing here is imported statically except `@opentelemetry/api`, which is a
 * no-op facade the project already depends on. The tracer provider, the meter
 * provider, the samplers, the resource builder, the context manager, and both
 * OTLP exporters are loaded with `await import(...)` **inside the enabled
 * branch**, and that is the mechanism behind the whole optionality contract:
 *
 * - With `TELEMETRY_ENABLED=false` the SDK is never loaded. Not "loaded and
 *   unused" — the modules are never evaluated, so there is no exporter object, no
 *   batch queue, no export timer, no metric reader interval, no DNS lookup, and
 *   no socket. `pnpm verify`, `next build`, and the end-to-end run all prove it on
 *   a machine with no collector anywhere.
 * - The liveness and readiness endpoints keep their import graphs. A static import
 *   here would put thirty packages into every process that touches the
 *   observability platform, including the two operational probes whose entire
 *   value is that they reach almost nothing.
 * - Removing telemetry stays a deletion. The SDK appears in exactly one file.
 *
 * ## Why the SDK is assembled by hand
 *
 * `@opentelemetry/sdk-node` would be one import instead of six, and it is not
 * used, because it depends on the Prometheus exporter, the Zipkin exporter, three
 * gRPC exporters, three protobuf exporters, the Jaeger propagator, and the OTLP
 * logs SDK. This application exports traces and metrics over one transport —
 * OTLP/HTTP — and installs no automatic instrumentation, so a package that
 * carries five transports it will never use is a supply-chain cost with no
 * benefit. Assembling the four pieces by hand is a dozen lines and names exactly
 * what runs.
 *
 * No automatic instrumentation is registered, deliberately. Automatic HTTP and
 * Prisma instrumentation would produce spans nobody wrote — carrying full URLs,
 * query text, and connection details — which is the opposite of the allowlists
 * every other span in this application passes through.
 *
 * ## Failure containment
 *
 * `start` never throws and never rejects. A configuration that cannot produce an
 * exporter, an SDK module that fails to load, a provider constructor that throws:
 * each resolves to a stable status, is logged once, and leaves the application
 * running with the no-op API. Telemetry is not a startup dependency.
 */
export type ProductionTelemetryHandle = Readonly<{
  processType: TelemetryProcessType;
  status: TelemetryStatus;
}>;

export type StartProductionTelemetryOptions = Readonly<{
  processType: TelemetryProcessType;
  /** Overridden only by tests that capture the lifecycle lines. */
  logger?: StructuredLogger;
}>;

/**
 * What has to be released on shutdown.
 *
 * Both providers are held, not just one: shutting down the tracer provider stops
 * the batch processor's timer, and shutting down the meter provider stops the
 * periodic reader's interval. Missing either leaves a process that will not exit.
 */
type TelemetryRuntime = Readonly<{
  shutdown: () => Promise<void>;
  forceFlush: () => Promise<void>;
}>;

type TelemetryState = {
  startup?: Promise<ProductionTelemetryHandle>;
  runtime?: TelemetryRuntime;
  shutdown?: Promise<void>;
  status: TelemetryStatus;
  processType: TelemetryProcessType;
};

const globalForTelemetry = globalThis as typeof globalThis & {
  productionTelemetryState?: TelemetryState;
};

function state(): TelemetryState {
  globalForTelemetry.productionTelemetryState ??= {
    status: TELEMETRY_STATUS.DISABLED,
    processType: TELEMETRY_PROCESS_TYPE.WEB,
  };

  return globalForTelemetry.productionTelemetryState;
}

/**
 * The ceiling on a flush and on a shutdown.
 *
 * A deployment's rolling restart waits for this, and an exporter whose collector
 * has gone away will otherwise wait for its own socket timeout. Five seconds is
 * long enough for a batch to leave and short enough that a dead collector cannot
 * hold a container open.
 */
export const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Waits for an operation, but not forever, and always clears its timer.
 *
 * A rejection is swallowed on purpose: this is used only for flush and shutdown,
 * where the caller has already decided that a failure to export must not change
 * the exit code of a process whose actual work succeeded.
 */
async function settleWithin(
  operation: () => Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  try {
    await Promise.race([
      operation().then(
        () => undefined,
        () => undefined,
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The resource every span and every metric carries.
 *
 * It is built from four named attributes and nothing else. No automatic resource
 * detection runs — not the host detector, not the process detector, not the OS or
 * container or cloud ones — because each of them adds an attribute that is either
 * an identifier (`host.name`, `process.pid`, `container.id`) or a piece of
 * infrastructure topology, and all of them travel to a third party on every
 * single span. What an operator needs to tell two deployments apart is the service,
 * its release, its environment, and whether it is the web process or the worker.
 */
async function createTelemetryResource(
  configuration: Extract<TelemetryConfiguration, { enabled: true }>,
  processType: TelemetryProcessType,
) {
  const [{ resourceFromAttributes }, semconv] = await Promise.all([
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
  ]);

  return resourceFromAttributes({
    [semconv.ATTR_SERVICE_NAME]: configuration.serviceName,
    ...(configuration.serviceVersion === undefined
      ? {}
      : { [semconv.ATTR_SERVICE_VERSION]: configuration.serviceVersion }),
    // Stable in the semantic conventions but only exported from the incubating
    // entry point, so the name is written out rather than reached for through a
    // subpath whose contents are explicitly unstable.
    "deployment.environment.name": configuration.environment,
    "app.process.type": processType,
  });
}

async function startTelemetryRuntime(
  configuration: Extract<TelemetryConfiguration, { enabled: true }>,
  processType: TelemetryProcessType,
): Promise<TelemetryRuntime> {
  const [
    resource,
    sdkTrace,
    sdkMetrics,
    traceExporterModule,
    metricExporterModule,
    contextModule,
    coreModule,
  ] = await Promise.all([
    createTelemetryResource(configuration, processType),
    import("@opentelemetry/sdk-trace"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/context-async-hooks"),
    import("@opentelemetry/core"),
  ]);

  const headers = configuration.headers;

  const traceExporter = new traceExporterModule.OTLPTraceExporter({
    // Always explicit. Leaving it out would let the exporter fall back to its own
    // `localhost:4318` default, which is the silent misconfiguration this whole
    // area is arranged to prevent.
    url: configuration.traceEndpoint,
    timeoutMillis: configuration.exportTimeoutMs,
    ...(headers === undefined ? {} : { headers: { ...headers } }),
  });

  const metricExporter = new metricExporterModule.OTLPMetricExporter({
    url: configuration.metricEndpoint,
    timeoutMillis: configuration.exportTimeoutMs,
    ...(headers === undefined ? {} : { headers: { ...headers } }),
  });

  /**
   * Parent-based ratio sampling on the trace id.
   *
   * The parent decision wins whenever there is a parent, which is what makes a
   * request, the outbox row it wrote, and the job that row produced either all
   * sampled or all dropped — a half-sampled trace is worse than no trace, because
   * it looks like a broken system. A root span with no parent falls back to the
   * ratio, applied to the trace id, so the decision is deterministic and needs no
   * coordination between processes.
   *
   * Nothing about the caller enters the decision. Not a user id, not a route, not
   * a header, not a payload: a sampler that could be steered by input is a sampler
   * an attacker can use to hide.
   */
  const sampler = new sdkTrace.ParentBasedSampler({
    root: new sdkTrace.TraceIdRatioBasedSampler(configuration.traceSampleRatio),
  });

  const spanProcessor = new sdkTrace.BatchSpanProcessor({
    exporter: traceExporter,
    exportTimeoutMillis: configuration.exportTimeoutMs,
  });

  const tracerProvider = new sdkTrace.TracerProvider({
    resource,
    sampler,
    spanProcessors: [spanProcessor],
    forceFlushTimeoutMillis: configuration.exportTimeoutMs,
  });

  const metricReader = new sdkMetrics.PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: configuration.metricExportIntervalMs,
    exportTimeoutMillis: configuration.exportTimeoutMs,
  });

  const meterProvider = new sdkMetrics.MeterProvider({
    resource,
    readers: [metricReader],
  });

  // `AsyncLocalStorage` rather than the older async-hooks manager: it is the one
  // the Node runtime supports natively, and it is the same primitive the request
  // context already uses, so a span survives an `await` the same way a request id
  // does.
  const contextManager =
    new contextModule.AsyncLocalStorageContextManager().enable();

  otelContext.setGlobalContextManager(contextManager);
  // W3C trace context alone. No B3, no Jaeger format, and — deliberately — no
  // baggage propagator: baggage is an open key/value bag that travels with a
  // request and is the field most likely to be carrying a user identifier.
  propagation.setGlobalPropagator(new coreModule.W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(tracerProvider);
  otelMetrics.setGlobalMeterProvider(meterProvider);

  // Any instrument created before this point is bound to the no-op provider and
  // would silently record nothing forever.
  resetTelemetryInstruments();

  return {
    forceFlush: async () => {
      await Promise.all([
        tracerProvider.forceFlush(),
        meterProvider.forceFlush(),
      ]);
    },
    shutdown: async () => {
      // The API globals are released first, so nothing can obtain a tracer or a
      // meter from a provider that is in the middle of shutting down.
      trace.disable();
      otelMetrics.disable();
      propagation.disable();
      otelContext.disable();
      contextManager.disable();

      resetTelemetryInstruments();

      // Both, and both awaited: one owns the batch timer, the other owns the
      // export interval, and a process with either still armed will not exit.
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };
}

function logLifecycle(
  logger: StructuredLogger,
  event: (typeof TELEMETRY_LOG_EVENT)[keyof typeof TELEMETRY_LOG_EVENT],
  processType: TelemetryProcessType,
  status: TelemetryStatus,
  durationMs?: number,
): void {
  try {
    const fields = toTelemetryLogFields({ processType, status, durationMs });

    if (event === TELEMETRY_LOG_EVENT.START_FAILED) {
      logger.error(fields, event);

      return;
    }

    logger.info(fields, event);
  } catch {
    // A telemetry line that cannot be written is not worth a failed startup.
  }
}

async function startOnce(
  options: StartProductionTelemetryOptions,
): Promise<ProductionTelemetryHandle> {
  const { processType } = options;
  const logger = options.logger ?? rootLogger;
  const configuration = getTelemetryConfiguration();
  const current = state();

  current.processType = processType;
  // A fresh start clears any completed shutdown, so a restarted process — or a
  // test that starts, stops, and starts again — is not left holding the promise
  // of a shutdown that already finished.
  current.shutdown = undefined;

  if (!configuration.enabled) {
    current.status = configuration.status;

    // Logged once, and only when the operator asked for telemetry and did not get
    // it. A line saying "telemetry is disabled" on every boot of every process
    // that never wanted telemetry is noise.
    if (configuration.status === TELEMETRY_STATUS.INVALID_CONFIGURATION) {
      logLifecycle(
        logger,
        TELEMETRY_LOG_EVENT.START_FAILED,
        processType,
        configuration.status,
      );
    }

    return { processType, status: configuration.status };
  }

  try {
    current.runtime = await startTelemetryRuntime(configuration, processType);
    current.status = TELEMETRY_STATUS.STARTED;

    logLifecycle(
      logger,
      TELEMETRY_LOG_EVENT.STARTED,
      processType,
      current.status,
    );

    return { processType, status: current.status };
  } catch {
    // Nothing about the failure is reported beyond the status. The values in
    // scope here are an endpoint and a header credential, and an SDK error
    // message is where both of them would appear.
    current.status = TELEMETRY_STATUS.START_FAILED;
    current.runtime = undefined;

    // The shared promise is cleared so a later call can try again. A poisoned
    // singleton would make one transient failure permanent for the life of the
    // process — and would make the failure path untestable.
    current.startup = undefined;

    logLifecycle(
      logger,
      TELEMETRY_LOG_EVENT.START_FAILED,
      processType,
      current.status,
    );

    return { processType, status: current.status };
  }
}

/**
 * Starts telemetry for this process, at most once.
 *
 * Concurrent callers share one promise rather than racing to build two SDKs: the
 * shared promise is stored before the first `await`, so a second call that arrives
 * mid-initialization joins the first one instead of registering a second provider
 * over the top of it.
 */
export function startProductionTelemetry(
  options: StartProductionTelemetryOptions,
): Promise<ProductionTelemetryHandle> {
  const current = state();

  return (current.startup ??= startOnce(options));
}

/** The current status. `disabled` before anything has been started. */
export function productionTelemetryStatus(): TelemetryStatus {
  return state().status;
}

/**
 * Flushes whatever is buffered, within the shutdown budget.
 *
 * Best effort by contract: a worker that finished its jobs and could not reach the
 * collector has still finished its jobs.
 */
export async function forceFlushProductionTelemetry(): Promise<void> {
  const runtime = state().runtime;

  if (!runtime) {
    return;
  }

  await settleWithin(runtime.forceFlush, TELEMETRY_SHUTDOWN_TIMEOUT_MS);
}

/**
 * Releases every provider, reader, exporter, and timer.
 *
 * Idempotent: a second call joins the shutdown already in progress rather than
 * shutting down a provider that is already down. It never throws, so an exporter
 * that fails to close cannot change the exit code of a process whose work
 * succeeded.
 */
export function shutdownProductionTelemetry(): Promise<void> {
  const current = state();

  return (current.shutdown ??= (async () => {
    const runtime = current.runtime;
    const startedStatus = current.status;

    current.runtime = undefined;
    current.startup = undefined;

    if (!runtime) {
      return;
    }

    const timer = startOperationTimer();

    await settleWithin(runtime.shutdown, TELEMETRY_SHUTDOWN_TIMEOUT_MS);

    current.status = TELEMETRY_STATUS.STOPPED;

    if (startedStatus === TELEMETRY_STATUS.STARTED) {
      logLifecycle(
        rootLogger,
        TELEMETRY_LOG_EVENT.STOPPED,
        current.processType,
        current.status,
        timer.elapsedMs(),
      );
    }
  })());
}

/**
 * Forgets the lifecycle state without shutting anything down.
 *
 * Teardown for tests and for an explicit restart, in the same spirit as
 * `closeStorageClient` and `resetJobsConfiguration`. A caller that has started
 * telemetry must call `shutdownProductionTelemetry` first; this only clears the
 * bookkeeping so the next `start` is a fresh one.
 */
export function resetProductionTelemetry(): void {
  globalForTelemetry.productionTelemetryState = {
    status: TELEMETRY_STATUS.DISABLED,
    processType: TELEMETRY_PROCESS_TYPE.WEB,
  };
}
