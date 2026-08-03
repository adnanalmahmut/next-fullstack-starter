import {
  metrics,
  type BatchObservableCallback,
  type BatchObservableResult,
  type Meter,
  type Observable,
} from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_METRIC_OBSERVER_BUDGET_MS,
  METRIC,
  METRIC_NAMES,
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
} from "./metrics.server";

type RecordedCall = Readonly<{
  name: string;
  value: number;
  attributes: Record<string, unknown> | undefined;
}>;

/**
 * A meter double that records what was created and what was recorded.
 *
 * A real `MeterProvider` would work here too, but it would also aggregate — and
 * what these tests are about is the *shape* of what this file emits: the instrument
 * names, the units, the attribute keys, and the number of times each one is
 * touched.
 */
function createMeterDouble() {
  const counters = new Map<string, number>();
  const histograms = new Map<string, number>();
  const gauges = new Map<string, number>();
  const adds: RecordedCall[] = [];
  const records: RecordedCall[] = [];
  const callbacks: BatchObservableCallback[] = [];

  const meter = {
    createCounter: (name: string) => {
      counters.set(name, (counters.get(name) ?? 0) + 1);

      return {
        add: (value: number, attributes?: Record<string, unknown>) => {
          adds.push({ name, value, attributes });
        },
      };
    },
    createHistogram: (name: string) => {
      histograms.set(name, (histograms.get(name) ?? 0) + 1);

      return {
        record: (value: number, attributes?: Record<string, unknown>) => {
          records.push({ name, value, attributes });
        },
      };
    },
    createObservableGauge: (name: string) => {
      gauges.set(name, (gauges.get(name) ?? 0) + 1);

      return { name } as unknown as Observable;
    },
    addBatchObservableCallback: (callback: BatchObservableCallback) => {
      callbacks.push(callback);
    },
    removeBatchObservableCallback: (callback: BatchObservableCallback) => {
      const index = callbacks.indexOf(callback);

      if (index >= 0) {
        callbacks.splice(index, 1);
      }
    },
  };

  vi.spyOn(metrics, "getMeter").mockReturnValue(meter as unknown as Meter);

  return { counters, histograms, gauges, adds, records, callbacks };
}

beforeEach(() => {
  resetTelemetryInstruments();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetTelemetryInstruments();
});

describe("with no meter provider registered", () => {
  it("records without throwing and changes nothing", () => {
    expect(() => {
      recordRouteRequest({
        routeName: "identity.user.list",
        method: "GET",
        statusCode: 200,
        outcome: "succeeded",
        durationMs: 12,
      });
      recordActionExecution({
        actionName: "identity.user.rename",
        outcome: "succeeded",
        durationMs: 3,
      });
      recordJobExecution({
        jobName: "mail.send",
        jobVersion: 1,
        outcome: "succeeded",
        durationMs: 4,
      });
      recordStorageFailure({
        operation: "storage.head",
        failureCode: "unavailable",
      });
    }).not.toThrow();
  });
});

describe("the metric registry", () => {
  it("is closed and stable", () => {
    expect(METRIC).toEqual({
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
    });
    expect(METRIC_NAMES).toHaveLength(Object.keys(METRIC).length);
  });

  it("prefixes every name with the application namespace", () => {
    for (const name of METRIC_NAMES) {
      expect(name.startsWith("app."), name).toBe(true);
    }
  });
});

describe("instrument reuse", () => {
  it("creates each instrument once per process", () => {
    const meter = createMeterDouble();

    for (let index = 0; index < 5; index += 1) {
      recordRouteRequest({
        routeName: "identity.user.list",
        method: "GET",
        statusCode: 200,
        outcome: "succeeded",
        durationMs: index,
      });
    }

    expect(meter.counters.get(METRIC.ROUTE_REQUESTS)).toBe(1);
    expect(meter.histograms.get(METRIC.ROUTE_DURATION)).toBe(1);
    expect(meter.adds).toHaveLength(5);
    expect(meter.records).toHaveLength(5);
  });

  it("rebuilds instruments after a reset", () => {
    const meter = createMeterDouble();

    recordJobRetry({ jobName: "mail.send", jobVersion: 1 });
    resetTelemetryInstruments();
    recordJobRetry({ jobName: "mail.send", jobVersion: 1 });

    // An instrument obtained from the no-op provider stays a no-op forever, so the
    // cache has to be dropped when the provider changes.
    expect(meter.counters.get(METRIC.JOB_RETRIES)).toBe(2);
  });
});

describe("route metrics", () => {
  it("carries only low-cardinality dimensions", () => {
    const meter = createMeterDouble();

    recordRouteRequest({
      routeName: "identity.user.list",
      method: "GET",
      statusCode: 200,
      outcome: "succeeded",
      durationMs: 1_500,
    });

    const expected = {
      "route.name": "identity.user.list",
      "http.request.method": "GET",
      "http.response.status_code": 200,
      outcome: "succeeded",
    };

    expect(meter.adds[0]).toEqual({
      name: METRIC.ROUTE_REQUESTS,
      value: 1,
      attributes: expected,
    });
    // Seconds, as the OpenTelemetry conventions require, even though every
    // duration in this codebase is measured in milliseconds.
    expect(meter.records[0]).toEqual({
      name: METRIC.ROUTE_DURATION,
      value: 1.5,
      attributes: expected,
    });
  });

  it("never carries a request id, an actor, or a path", () => {
    const meter = createMeterDouble();

    recordRouteRequest({
      routeName: "identity.user.role.set",
      method: "PATCH",
      statusCode: 403,
      outcome: "failed",
      durationMs: 5,
    });

    const keys = Object.keys(meter.adds[0]?.attributes ?? {});

    for (const forbidden of [
      "requestId",
      "request_id",
      "userId",
      "user_id",
      "actor",
      "path",
      "url",
      "locale",
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});

describe("action metrics", () => {
  it("adds the error code to the count and not to the histogram", () => {
    const meter = createMeterDouble();

    recordActionExecution({
      actionName: "identity.user.rename",
      outcome: "failed",
      errorCode: "VALIDATION_FAILED",
      durationMs: 250,
    });

    expect(meter.adds[0]?.attributes).toEqual({
      "action.name": "identity.user.rename",
      outcome: "failed",
      error_code: "VALIDATION_FAILED",
    });
    // Adding the code to the histogram would multiply the bucket set by the error
    // vocabulary for no question anybody asks of a duration.
    expect(meter.records[0]?.attributes).toEqual({
      "action.name": "identity.user.rename",
      outcome: "failed",
    });
    expect(meter.records[0]?.value).toBe(0.25);
  });

  it("omits the error code on success", () => {
    const meter = createMeterDouble();

    recordActionExecution({
      actionName: "identity.user.rename",
      outcome: "succeeded",
      durationMs: 1,
    });

    expect(meter.adds[0]?.attributes).toEqual({
      "action.name": "identity.user.rename",
      outcome: "succeeded",
    });
  });
});

describe("job and outbox metrics", () => {
  it("counts an attempt and its duration under the closed job identity", () => {
    const meter = createMeterDouble();

    recordJobExecution({
      jobName: "mail.send",
      jobVersion: 2,
      outcome: "retrying",
      durationMs: 2_000,
    });

    const expected = {
      "job.name": "mail.send",
      "job.version": 2,
      "job.outcome": "retrying",
    };

    expect(meter.adds[0]?.attributes).toEqual(expected);
    expect(meter.records[0]).toEqual({
      name: METRIC.JOB_DURATION,
      value: 2,
      attributes: expected,
    });
  });

  it("counts a retry and a dead letter separately", () => {
    const meter = createMeterDouble();
    const identity = { jobName: "mail.send", jobVersion: 1 };

    recordJobRetry(identity);
    recordJobDeadLettered(identity);
    recordOutboxPublish({ ...identity, outcome: "succeeded" });
    recordOutboxPublishRetry(identity);
    recordOutboxDeadLettered(identity);

    expect(meter.adds.map((call) => call.name)).toEqual([
      METRIC.JOB_RETRIES,
      METRIC.JOB_DEAD_LETTERED,
      METRIC.OUTBOX_PUBLISH,
      METRIC.OUTBOX_PUBLISH_RETRIES,
      METRIC.OUTBOX_DEAD_LETTERED,
    ]);
  });

  it("never carries a job id, an outbox id, or a queue key", () => {
    const meter = createMeterDouble();

    recordJobExecution({
      jobName: "mail.send",
      jobVersion: 1,
      outcome: "failed",
      durationMs: 1,
    });

    const keys = Object.keys(meter.adds[0]?.attributes ?? {});

    for (const forbidden of [
      "jobId",
      "job.id",
      "outboxId",
      "outbox.id",
      "correlationId",
      "queueName",
      "queue.name",
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});

describe("storage failure metrics", () => {
  it("carries the operation and the failure code only", () => {
    const meter = createMeterDouble();

    recordStorageFailure({
      operation: "storage.presign_upload",
      failureCode: "access-denied",
    });

    expect(meter.adds[0]).toEqual({
      name: METRIC.STORAGE_FAILURES,
      value: 1,
      attributes: {
        operation: "storage.presign_upload",
        failure_code: "access-denied",
      },
    });
  });
});

describe("the outbox backlog observer", () => {
  async function collectOnce(
    callbacks: readonly BatchObservableCallback[],
  ): Promise<RecordedCall[]> {
    const observed: RecordedCall[] = [];
    const result = {
      observe: (
        instrument: Observable,
        value: number,
        attributes?: Record<string, unknown>,
      ) => {
        observed.push({
          name: (instrument as unknown as { name: string }).name,
          value,
          attributes,
        });
      },
    } as unknown as BatchObservableResult;

    for (const callback of callbacks) {
      await callback(result);
    }

    return observed;
  }

  it("reports the four bounded states", async () => {
    const meter = createMeterDouble();
    const registration = registerOutboxBacklogObserver(async () => ({
      pending: 4,
      due: 3,
      leased: 2,
      deadLettered: 1,
    }));

    const observed = await collectOnce(meter.callbacks);

    expect(observed).toEqual([
      {
        name: METRIC.OUTBOX_BACKLOG,
        value: 4,
        attributes: { state: OUTBOX_BACKLOG_STATE.PENDING },
      },
      {
        name: METRIC.OUTBOX_BACKLOG,
        value: 3,
        attributes: { state: OUTBOX_BACKLOG_STATE.DUE },
      },
      {
        name: METRIC.OUTBOX_BACKLOG,
        value: 2,
        attributes: { state: OUTBOX_BACKLOG_STATE.LEASED },
      },
      {
        name: METRIC.OUTBOX_BACKLOG,
        value: 1,
        attributes: { state: OUTBOX_BACKLOG_STATE.DEAD_LETTERED },
      },
    ]);

    registration.unregister();
  });

  it("reports nothing when the observer fails", async () => {
    const meter = createMeterDouble();
    const registration = registerOutboxBacklogObserver(async () => {
      throw new Error("the database is unreachable");
    });

    // A backlog query that failed is a missing sample, never a failed worker.
    await expect(collectOnce(meter.callbacks)).resolves.toEqual([]);

    registration.unregister();
  });

  it("drops a cycle that begins while the previous one is running", async () => {
    const meter = createMeterDouble();
    let started = 0;
    let release: (() => void) | undefined;

    const registration = registerOutboxBacklogObserver(async () => {
      started += 1;

      await new Promise<void>((resolve) => {
        release = resolve;
      });

      return { pending: 1, due: 1, leased: 0, deadLettered: 0 };
    });

    const first = collectOnce(meter.callbacks);

    // The second cycle must not queue behind the first, or a slow database would
    // stack collections until one of them wins.
    await expect(collectOnce(meter.callbacks)).resolves.toEqual([]);

    release?.();
    await first;

    expect(started).toBe(1);

    registration.unregister();
  });

  it("stops observing once unregistered", async () => {
    const meter = createMeterDouble();
    const observe = vi.fn(async () => ({
      pending: 1,
      due: 1,
      leased: 1,
      deadLettered: 1,
    }));
    const registration = registerOutboxBacklogObserver(observe);
    const callbacks = [...meter.callbacks];

    registration.unregister();

    // Both guards hold: the callback was removed from the meter, and the flag
    // disarms one that a provider still happens to hold.
    expect(meter.callbacks).toEqual([]);
    await expect(collectOnce(callbacks)).resolves.toEqual([]);
    expect(observe).not.toHaveBeenCalled();
  });

  it("bounds a collection cycle", () => {
    // Documented next to the implementation, so a stuck query is reported as a
    // missing sample rather than as a stuck exporter.
    expect(MAX_METRIC_OBSERVER_BUDGET_MS).toBeGreaterThan(0);
    expect(MAX_METRIC_OBSERVER_BUDGET_MS).toBeLessThanOrEqual(30_000);
  });

  it("leaves no timer behind after a fast cycle", async () => {
    const meter = createMeterDouble();

    vi.useFakeTimers();

    try {
      const registration = registerOutboxBacklogObserver(async () => ({
        pending: 0,
        due: 0,
        leased: 0,
        deadLettered: 0,
      }));

      await collectOnce(meter.callbacks);
      registration.unregister();

      // A pending budget timer is the difference between a process that exits and
      // one that reports an open handle; `withObserverBudget` clears it in
      // `finally` rather than leaving it to expire.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("metric failure containment", () => {
  it("swallows a meter that throws", () => {
    vi.spyOn(metrics, "getMeter").mockImplementation(() => {
      throw new Error("meter provider is broken");
    });

    expect(() =>
      recordRouteRequest({
        routeName: "identity.user.list",
        method: "GET",
        statusCode: 200,
        outcome: "succeeded",
        durationMs: 1,
      }),
    ).not.toThrow();
  });

  it("swallows a counter that throws", () => {
    vi.spyOn(metrics, "getMeter").mockReturnValue({
      createCounter: () => ({
        add: () => {
          throw new Error("add is broken");
        },
      }),
      createHistogram: () => ({ record: () => undefined }),
    } as unknown as Meter);

    expect(() =>
      recordStorageFailure({ operation: "storage.head", failureCode: "x" }),
    ).not.toThrow();
  });

  it("swallows a histogram that throws", () => {
    vi.spyOn(metrics, "getMeter").mockReturnValue({
      createCounter: () => ({ add: () => undefined }),
      createHistogram: () => ({
        record: () => {
          throw new Error("record is broken");
        },
      }),
    } as unknown as Meter);

    expect(() =>
      recordActionExecution({
        actionName: "identity.user.rename",
        outcome: "succeeded",
        durationMs: 1,
      }),
    ).not.toThrow();
  });

  it("answers a no-op registration when the gauge cannot be created", () => {
    vi.spyOn(metrics, "getMeter").mockReturnValue({
      createObservableGauge: () => {
        throw new Error("gauge is broken");
      },
    } as unknown as Meter);

    const registration = registerOutboxBacklogObserver(async () => null);

    expect(() => registration.unregister()).not.toThrow();
  });
});
