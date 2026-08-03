import "server-only";

import {
  metrics,
  type BatchObservableResult,
  type Counter,
  type Histogram,
  type Meter,
  type ObservableGauge,
} from "@opentelemetry/api";

/**
 * The one metrics contract in this application, expressed through
 * `@opentelemetry/api` and nothing else.
 *
 * As with tracing, the API package is a facade: with no meter provider registered
 * every instrument below is a no-op, so a call site records the same way whether
 * or not a collector exists. Registering a provider is the lifecycle module's job.
 *
 * Three properties are worth stating rather than inferring, because each one is a
 * decision that would otherwise be made accidentally at a call site:
 *
 * - **The instrument set is closed.** Every metric this application can emit is
 *   named in `METRIC` below, and every one of them is created by a function in
 *   this file. There is no `recordMetric(name, value)`, so a feature cannot invent
 *   a metric name, and a dashboard cannot break because somebody typed one.
 * - **Every instrument is created once per process.** An instrument is a handle
 *   on aggregation state; creating one per request would allocate on every
 *   request and, worse, would make the SDK deduplicate by name and warn. The cache
 *   is cleared when the provider changes so instruments are never left bound to a
 *   provider that has been shut down.
 * - **Attributes are typed and closed.** Each recorder takes a named field set
 *   and builds the attribute map here. Nothing accepts an open map, so no
 *   identifier, payload, key, or address can become a metric dimension — and
 *   cardinality is a property of this file rather than of production traffic.
 *
 * Durations are recorded in **seconds**, as OpenTelemetry's semantic conventions
 * require, even though every duration in this codebase is measured in
 * milliseconds. The conversion happens in one place per recorder.
 */
export const METRIC = {
  ROUTE_REQUESTS: "app.route.requests",
  ROUTE_DURATION: "app.route.duration",
  ACTION_EXECUTIONS: "app.action.executions",
  ACTION_DURATION: "app.action.duration",
  JOB_EXECUTIONS: "app.jobs.executions",
  JOB_DURATION: "app.jobs.duration",
  JOB_RETRIES: "app.jobs.retries",
  JOB_DEAD_LETTERED: "app.jobs.dead_lettered",
  OUTBOX_PUBLISH: "app.outbox.publish",
  OUTBOX_PUBLISH_RETRIES: "app.outbox.publish_retries",
  OUTBOX_DEAD_LETTERED: "app.outbox.dead_lettered",
  OUTBOX_BACKLOG: "app.outbox.backlog",
  STORAGE_FAILURES: "app.storage.failures",
} as const;

export type MetricName = (typeof METRIC)[keyof typeof METRIC];

/** Every metric name, for the contract test that asserts the set is closed. */
export const METRIC_NAMES = Object.values(METRIC) as readonly MetricName[];

const METER_NAME = "next-fullstack-starter";

/** The unit strings, kept next to the names so the catalog has one source. */
const SECONDS = "s";
const COUNT = "1";

type MetricAttributes = Readonly<Record<string, string | number>>;

type InstrumentState = {
  meter?: Meter;
  counters: Map<string, Counter>;
  histograms: Map<string, Histogram>;
  gauges: Map<string, ObservableGauge>;
};

/**
 * Held on `globalThis` so a development reload reuses the instruments rather than
 * registering a second set against the same provider.
 */
const globalForInstruments = globalThis as typeof globalThis & {
  telemetryInstrumentState?: InstrumentState;
};

function state(): InstrumentState {
  globalForInstruments.telemetryInstrumentState ??= {
    counters: new Map(),
    histograms: new Map(),
    gauges: new Map(),
  };

  return globalForInstruments.telemetryInstrumentState;
}

function meter(): Meter {
  const current = state();

  current.meter ??= metrics.getMeter(METER_NAME);

  return current.meter;
}

/**
 * Forgets every cached instrument and the meter behind them.
 *
 * Called when the meter provider is registered and again when it is shut down. An
 * instrument obtained from the no-op provider stays a no-op forever, so a process
 * that created one before telemetry started would silently record nothing; and an
 * instrument held after shutdown would keep a reference to a released provider.
 */
export function resetTelemetryInstruments(): void {
  const current = state();

  current.meter = undefined;
  current.counters.clear();
  current.histograms.clear();
  current.gauges.clear();
}

function counter(name: MetricName, description: string, unit: string): Counter {
  const current = state();
  const existing = current.counters.get(name);

  if (existing) {
    return existing;
  }

  const created = meter().createCounter(name, { description, unit });

  current.counters.set(name, created);

  return created;
}

function histogram(
  name: MetricName,
  description: string,
  unit: string,
): Histogram {
  const current = state();
  const existing = current.histograms.get(name);

  if (existing) {
    return existing;
  }

  const created = meter().createHistogram(name, { description, unit });

  current.histograms.set(name, created);

  return created;
}

/**
 * Adds to a counter, or does nothing at all.
 *
 * Getting a meter, creating an instrument, and recording a value are three
 * separate calls into a third-party SDK, and any of them can throw. None of them
 * may change what the surrounding operation returns, so the whole sequence is
 * inside one guard.
 */
function addSafely(
  name: MetricName,
  description: string,
  attributes: MetricAttributes,
  value = 1,
): void {
  try {
    counter(name, description, COUNT).add(value, attributes);
  } catch {
    // A metrics failure is not an operation failure.
  }
}

function recordSecondsSafely(
  name: MetricName,
  description: string,
  attributes: MetricAttributes,
  durationMs: number,
): void {
  try {
    histogram(name, description, SECONDS).record(
      Math.max(0, durationMs) / 1_000,
      attributes,
    );
  } catch {
    // A metrics failure is not an operation failure.
  }
}

/* -------------------------------------------------------------------------- */
/* Route Handlers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What a route request may contribute as dimensions.
 *
 * The request id is deliberately absent: it is unique per request, so using it as
 * a dimension would create one time series per request and would make the metric
 * more expensive than the traffic it measures. The actor, the path, the query, the
 * body, and the output are absent for the reasons they are absent from a log line.
 */
export type RouteMetricFields = Readonly<{
  routeName: string;
  method: string;
  statusCode: number;
  outcome: string;
  durationMs: number;
}>;

export function recordRouteRequest(fields: RouteMetricFields): void {
  const attributes: MetricAttributes = {
    "route.name": fields.routeName,
    "http.request.method": fields.method,
    "http.response.status_code": fields.statusCode,
    outcome: fields.outcome,
  };

  addSafely(
    METRIC.ROUTE_REQUESTS,
    "Route Handler requests, by route, method, status, and outcome.",
    attributes,
  );
  recordSecondsSafely(
    METRIC.ROUTE_DURATION,
    "Route Handler duration in seconds, measured across the whole handler.",
    attributes,
    fields.durationMs,
  );
}

/* -------------------------------------------------------------------------- */
/* Server Actions                                                             */
/* -------------------------------------------------------------------------- */

export type ActionMetricFields = Readonly<{
  actionName: string;
  outcome: string;
  errorCode?: string | undefined;
  durationMs: number;
}>;

export function recordActionExecution(fields: ActionMetricFields): void {
  const dimensions: MetricAttributes = {
    "action.name": fields.actionName,
    outcome: fields.outcome,
  };

  addSafely(
    METRIC.ACTION_EXECUTIONS,
    "Server Action executions, by action, outcome, and stable error code.",
    // The error code is a dimension of the count only. Adding it to the
    // histogram as well would multiply the bucket set by the error vocabulary
    // for no question anybody asks of a duration.
    fields.errorCode === undefined
      ? dimensions
      : { ...dimensions, error_code: fields.errorCode },
  );
  recordSecondsSafely(
    METRIC.ACTION_DURATION,
    "Server Action duration in seconds, measured across the whole action.",
    dimensions,
    fields.durationMs,
  );
}

/* -------------------------------------------------------------------------- */
/* Background jobs                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `job.name` and `job.version` are safe dimensions precisely because the job
 * registry is closed and small: the set of series is a property of the code, not
 * of traffic. A job id, an outbox id, a correlation id, and a queue key are all
 * unbounded and are all absent.
 */
export type JobMetricFields = Readonly<{
  jobName: string;
  jobVersion: number;
  outcome: string;
}>;

export function recordJobExecution(
  fields: JobMetricFields & Readonly<{ durationMs: number }>,
): void {
  const attributes: MetricAttributes = {
    "job.name": fields.jobName,
    "job.version": fields.jobVersion,
    "job.outcome": fields.outcome,
  };

  addSafely(
    METRIC.JOB_EXECUTIONS,
    "Job execution attempts, by job, version, and attempt outcome.",
    attributes,
  );
  recordSecondsSafely(
    METRIC.JOB_DURATION,
    "Job execution duration in seconds, per attempt.",
    attributes,
    fields.durationMs,
  );
}

export type JobIdentityFields = Readonly<{
  jobName: string;
  jobVersion: number;
}>;

export function recordJobRetry(fields: JobIdentityFields): void {
  addSafely(METRIC.JOB_RETRIES, "Job attempts that will be retried.", {
    "job.name": fields.jobName,
    "job.version": fields.jobVersion,
  });
}

export function recordJobDeadLettered(fields: JobIdentityFields): void {
  addSafely(
    METRIC.JOB_DEAD_LETTERED,
    "Jobs that stopped being attempted, permanently or through an exhausted budget.",
    {
      "job.name": fields.jobName,
      "job.version": fields.jobVersion,
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Transactional outbox                                                       */
/* -------------------------------------------------------------------------- */

export function recordOutboxPublish(fields: JobMetricFields): void {
  addSafely(
    METRIC.OUTBOX_PUBLISH,
    "Outbox publish attempts, by job, version, and outcome.",
    {
      "job.name": fields.jobName,
      "job.version": fields.jobVersion,
      "job.outcome": fields.outcome,
    },
  );
}

export function recordOutboxPublishRetry(fields: JobIdentityFields): void {
  addSafely(
    METRIC.OUTBOX_PUBLISH_RETRIES,
    "Outbox rows rescheduled after a failed publish attempt.",
    {
      "job.name": fields.jobName,
      "job.version": fields.jobVersion,
    },
  );
}

export function recordOutboxDeadLettered(fields: JobIdentityFields): void {
  addSafely(
    METRIC.OUTBOX_DEAD_LETTERED,
    "Outbox rows moved to their dead letter.",
    {
      "job.name": fields.jobName,
      "job.version": fields.jobVersion,
    },
  );
}

/**
 * The four bounded states an outbox backlog is reported in.
 *
 * A gauge rather than a counter, because a backlog is a level and not an event
 * count; observable rather than synchronous, because nothing in the application
 * knows the level — it has to be asked of PostgreSQL at collection time.
 */
export type OutboxBacklogSnapshot = Readonly<{
  pending: number;
  due: number;
  leased: number;
  deadLettered: number;
}>;

export const OUTBOX_BACKLOG_STATE = {
  PENDING: "pending",
  DUE: "due",
  LEASED: "leased",
  DEAD_LETTERED: "dead_lettered",
} as const;

export type OutboxBacklogObserver = () => Promise<OutboxBacklogSnapshot | null>;

export type MetricObserverRegistration = Readonly<{
  /** Removes the callback. Idempotent, and safe to call after a shutdown. */
  unregister: () => void;
}>;

/**
 * The budget an observable callback gets.
 *
 * A collection cycle waits for every callback, so an unbounded one would stall
 * the export interval and hold the reader's promise open through a database
 * outage. Ten seconds is generous for a single bounded aggregate and short enough
 * that a stuck query is reported as a missing sample rather than as a stuck
 * exporter.
 */
export const MAX_METRIC_OBSERVER_BUDGET_MS = 10_000;

const NOOP_REGISTRATION: MetricObserverRegistration = {
  unregister: () => undefined,
};

function gauge(
  name: MetricName,
  description: string,
  unit: string,
): ObservableGauge {
  const current = state();
  const existing = current.gauges.get(name);

  if (existing) {
    return existing;
  }

  const created = meter().createObservableGauge(name, { description, unit });

  current.gauges.set(name, created);

  return created;
}

/**
 * Runs an observer under a deadline, and answers `null` rather than hanging.
 *
 * The timer is always cleared, so a fast observer does not leave a pending timer
 * behind — which is the difference between a test that exits and a test that
 * reports an open handle.
 */
async function withObserverBudget(
  observe: OutboxBacklogObserver,
): Promise<OutboxBacklogSnapshot | null> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), MAX_METRIC_OBSERVER_BUDGET_MS);
  });

  try {
    return await Promise.race([observe(), deadline]);
  } catch {
    // A backlog query that failed is a missing sample, never a failed worker.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registers the outbox backlog gauge against a caller-supplied observer.
 *
 * The instrument name and the state vocabulary are owned here, so the metric
 * catalog stays closed; the query is owned by the caller, because only the jobs
 * platform knows what an outbox row is. That split is also what keeps this file
 * free of any dependency on the jobs area.
 *
 * Two guards are not optional. The overlap guard drops a cycle that begins while
 * the previous one is still running, so a slow database cannot queue collections
 * behind each other until one of them wins; and the budget above bounds each
 * cycle. A failure in either case is a missing sample.
 */
export function registerOutboxBacklogObserver(
  observe: OutboxBacklogObserver,
): MetricObserverRegistration {
  let collecting = false;
  let active = true;

  const callback = async (result: BatchObservableResult): Promise<void> => {
    if (!active || collecting) {
      return;
    }

    collecting = true;

    try {
      const snapshot = await withObserverBudget(observe);

      if (!snapshot || !active) {
        return;
      }

      const instrument = gauge(
        METRIC.OUTBOX_BACKLOG,
        "Outbox rows awaiting publication, by state.",
        COUNT,
      );

      result.observe(instrument, snapshot.pending, {
        state: OUTBOX_BACKLOG_STATE.PENDING,
      });
      result.observe(instrument, snapshot.due, {
        state: OUTBOX_BACKLOG_STATE.DUE,
      });
      result.observe(instrument, snapshot.leased, {
        state: OUTBOX_BACKLOG_STATE.LEASED,
      });
      result.observe(instrument, snapshot.deadLettered, {
        state: OUTBOX_BACKLOG_STATE.DEAD_LETTERED,
      });
    } catch {
      // Observing is best effort. A callback that threw would be reported by the
      // SDK's diagnostic logger and must not reach the worker.
    } finally {
      collecting = false;
    }
  };

  try {
    const instrument = gauge(
      METRIC.OUTBOX_BACKLOG,
      "Outbox rows awaiting publication, by state.",
      COUNT,
    );

    meter().addBatchObservableCallback(callback, [instrument]);

    return {
      unregister: () => {
        active = false;

        try {
          meter().removeBatchObservableCallback(callback, [instrument]);
        } catch {
          // Removing a callback from a provider that is already shut down is
          // not a failure; the flag above has already disarmed it.
        }
      },
    };
  } catch {
    return NOOP_REGISTRATION;
  }
}

/* -------------------------------------------------------------------------- */
/* Object storage                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Storage failures, by operation and closed failure code.
 *
 * There is no success counter here on purpose: a successful presign is already
 * visible as a span, and the operational question a metric answers — "is the
 * bucket refusing us?" — is a failure question. The bucket, the endpoint, the
 * region, the object key, and the upload intent id are all absent.
 */
export type StorageFailureMetricFields = Readonly<{
  operation: string;
  failureCode: string;
}>;

export function recordStorageFailure(fields: StorageFailureMetricFields): void {
  addSafely(
    METRIC.STORAGE_FAILURES,
    "Object storage operations that failed, by operation and failure code.",
    {
      operation: fields.operation,
      failure_code: fields.failureCode,
    },
  );
}
