import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (value: unknown) => void;

type FakeWorker = {
  name: string;
  options: Record<string, unknown>;
  listeners: Map<string, Listener[]>;
  closedForcefully: boolean;
  closedGracefully: boolean;
};

const { workers, workerBehaviour, dispatcher, closeJobQueue, closeConnection } =
  vi.hoisted(() => ({
    workers: [] as FakeWorker[],
    workerBehaviour: { readyFails: false, closeHangs: false },
    dispatcher: {
      id: "dispatcher-1",
      runOnce: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      isRunning: vi.fn(() => false),
    },
    closeJobQueue: vi.fn(async () => undefined),
    closeConnection: vi.fn(async () => undefined),
  }));

vi.mock("bullmq", () => ({
  Worker: class {
    readonly listeners = new Map<string, Listener[]>();
    closedForcefully = false;
    closedGracefully = false;

    constructor(
      readonly name: string,
      readonly processor: unknown,
      readonly options: Record<string, unknown>,
    ) {
      workers.push(this as unknown as FakeWorker);
    }

    on(event: string, listener: Listener) {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);

      return this;
    }

    async waitUntilReady() {
      if (workerBehaviour.readyFails) {
        throw new Error("the worker could not reach Redis");
      }
    }

    async close(force?: boolean) {
      if (force) {
        this.closedForcefully = true;

        return;
      }

      if (workerBehaviour.closeHangs) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }

      this.closedGracefully = true;
    }
  },
  UnrecoverableError: class extends Error {},
}));

vi.mock("../queue/connection.server", () => ({
  createWorkerConnection: (url: string) => ({ url }),
  closeJobsConnection: closeConnection,
}));

vi.mock("../queue/job-queue.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  closeJobQueue,
}));

vi.mock("../outbox/outbox-dispatcher.server", () => ({
  createOutboxDispatcher: vi.fn(() => dispatcher),
}));

const { logJobEvent } = vi.hoisted(() => ({ logJobEvent: vi.fn() }));

vi.mock("../observability/job-logger.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logJobEvent,
}));

const { resetJobsConfiguration } = await import("../config/jobs-config");
const { createJobRegistry } = await import("../definitions/job-registry");
const { JOBS_LOG_EVENT } = await import("../observability/log-event");
const { createOutboxDispatcher } =
  await import("../outbox/outbox-dispatcher.server");
const { startJobsWorkerRuntime } = await import("./worker-runtime.server");

const registry = createJobRegistry([]);

function events(): string[] {
  return logJobEvent.mock.calls.map((call) => String(call[1]));
}

beforeEach(() => {
  workers.length = 0;
  workerBehaviour.readyFails = false;
  workerBehaviour.closeHangs = false;
  logJobEvent.mockClear();
  closeJobQueue.mockClear();
  closeConnection.mockClear();
  dispatcher.start.mockClear();
  dispatcher.stop.mockClear();
  vi.mocked(createOutboxDispatcher).mockClear();

  process.env.JOBS_ENABLED = "true";
  process.env.JOBS_REDIS_URL = "redis://127.0.0.1:6379";
  process.env.JOBS_WORKER_CONCURRENCY = "7";
  process.env.JOBS_WORKER_SHUTDOWN_TIMEOUT_MS = "1000";
  resetJobsConfiguration();
});

afterEach(() => {
  for (const name of [
    "JOBS_ENABLED",
    "JOBS_REDIS_URL",
    "JOBS_WORKER_CONCURRENCY",
    "JOBS_WORKER_SHUTDOWN_TIMEOUT_MS",
  ]) {
    delete process.env[name];
  }

  resetJobsConfiguration();
});

describe("starting", () => {
  it("refuses when jobs are disabled", async () => {
    process.env.JOBS_ENABLED = "false";
    resetJobsConfiguration();

    await expect(startJobsWorkerRuntime({ registry })).rejects.toThrow(
      /not enabled/,
    );
    expect(workers).toEqual([]);
  });

  it("refuses when no queue address is configured", async () => {
    delete process.env.JOBS_REDIS_URL;
    resetJobsConfiguration();

    await expect(startJobsWorkerRuntime({ registry })).rejects.toThrow(
      /JOBS_REDIS_URL/,
    );
    expect(workers).toEqual([]);
  });

  it("builds one worker with the configured prefix and concurrency", async () => {
    const runtime = await startJobsWorkerRuntime({ registry });

    expect(workers).toHaveLength(1);
    expect(workers[0]?.options.concurrency).toBe(7);
    expect(workers[0]?.options.prefix).toBeDefined();
    expect(runtime.concurrency).toBe(7);

    await runtime.stop();
  });

  it("lets a caller override the concurrency", async () => {
    const runtime = await startJobsWorkerRuntime({ registry, concurrency: 1 });

    expect(workers[0]?.options.concurrency).toBe(1);

    await runtime.stop();
  });

  it("starts the outbox dispatcher alongside the consumer", async () => {
    const runtime = await startJobsWorkerRuntime({ registry });

    expect(createOutboxDispatcher).toHaveBeenCalledWith({ registry });
    expect(dispatcher.start).toHaveBeenCalledTimes(1);

    await runtime.stop();
  });

  it("reports started and then ready", async () => {
    const runtime = await startJobsWorkerRuntime({ registry });

    expect(events()).toEqual([
      JOBS_LOG_EVENT.WORKER_STARTED,
      JOBS_LOG_EVENT.WORKER_READY,
    ]);

    await runtime.stop();
  });

  it("registers no signal handler", async () => {
    // A library that installed a SIGTERM handler would install it in every
    // process that imports it, including the test runner.
    const before = process.listenerCount("SIGTERM");
    const runtime = await startJobsWorkerRuntime({ registry });

    expect(process.listenerCount("SIGTERM")).toBe(before);

    await runtime.stop();
  });

  it("releases everything when the start fails", async () => {
    // Otherwise a supervisor restarting the process stacks up half-open
    // workers and live connections.
    workerBehaviour.readyFails = true;

    await expect(startJobsWorkerRuntime({ registry })).rejects.toThrow();
    expect(workers[0]?.closedForcefully).toBe(true);
    expect(closeConnection).toHaveBeenCalledTimes(1);
    expect(dispatcher.start).not.toHaveBeenCalled();
  });
});

describe("worker events", () => {
  it("handles the error event, because an unhandled one ends the process", async () => {
    const runtime = await startJobsWorkerRuntime({ registry });

    expect(workers[0]?.listeners.get("error")).toHaveLength(1);
    workers[0]?.listeners.get("error")?.[0]?.(new Error("blip"));

    expect(events()).toContain(JOBS_LOG_EVENT.QUEUE_WORKER_CONNECTION_FAILED);

    await runtime.stop();
  });

  it("records a stalled job, which is why handlers must be idempotent", async () => {
    const runtime = await startJobsWorkerRuntime({ registry });

    workers[0]?.listeners.get("stalled")?.[0]?.("job-1");

    expect(events()).toContain(JOBS_LOG_EVENT.JOB_STALLED);

    await runtime.stop();
  });
});

describe("stopping", () => {
  it("stops polling before it stops consuming", async () => {
    // No new message may be published while the worker is draining.
    const runtime = await startJobsWorkerRuntime({ registry });

    await runtime.stop();

    expect(dispatcher.stop).toHaveBeenCalledTimes(1);
    expect(workers[0]?.closedGracefully).toBe(true);
    expect(dispatcher.stop.mock.invocationCallOrder[0]).toBeLessThan(
      closeJobQueue.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("closes the queue and the connection last", async () => {
    const runtime = await startJobsWorkerRuntime({ registry });

    await runtime.stop();

    expect(closeJobQueue).toHaveBeenCalledTimes(1);
    expect(closeConnection).toHaveBeenCalledTimes(1);
    expect(events()).toEqual(
      expect.arrayContaining([
        JOBS_LOG_EVENT.WORKER_STOPPING,
        JOBS_LOG_EVENT.WORKER_STOPPED,
      ]),
    );
  });

  it("escalates to a forced close when the budget runs out", async () => {
    // `worker.close()` has no timeout of its own; an active job that ignores
    // its signal would keep a rolling restart waiting indefinitely.
    process.env.JOBS_WORKER_SHUTDOWN_TIMEOUT_MS = "1000";
    resetJobsConfiguration();
    workerBehaviour.closeHangs = true;

    const runtime = await startJobsWorkerRuntime({ registry });

    await runtime.stop();

    expect(workers[0]?.closedForcefully).toBe(true);
    expect(closeConnection).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("joins a shutdown already under way instead of closing twice", async () => {
    const runtime = await startJobsWorkerRuntime({ registry });

    await Promise.all([runtime.stop(), runtime.stop()]);
    await runtime.stop();

    expect(closeJobQueue).toHaveBeenCalledTimes(1);
    expect(dispatcher.stop).toHaveBeenCalledTimes(1);
  });
});
