import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (value: unknown) => void;

type FakeConnection = {
  url: string;
  options: Record<string, unknown>;
  listeners: Map<string, Listener[]>;
  quit: () => Promise<string>;
  disconnect: () => void;
};

const { instances, quitBehaviour } = vi.hoisted(() => ({
  instances: [] as FakeConnection[],
  quitBehaviour: { fail: false },
}));

vi.mock("ioredis", () => ({
  Redis: class {
    readonly listeners = new Map<string, Listener[]>();

    constructor(
      readonly url: string,
      readonly options: Record<string, unknown>,
    ) {
      instances.push(this as unknown as FakeConnection);
    }

    on(event: string, listener: Listener) {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);

      return this;
    }

    async quit() {
      if (quitBehaviour.fail) {
        throw new Error("connection is already gone");
      }

      return "OK";
    }

    disconnect() {
      this.listeners.set("disconnected", []);
    }
  },
}));

const { logJobEvent } = vi.hoisted(() => ({ logJobEvent: vi.fn() }));

vi.mock("../observability/job-logger.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logJobEvent,
}));

const {
  closeJobsConnection,
  createProducerConnection,
  createWorkerConnection,
  JOBS_CONNECT_TIMEOUT_MS,
  PRODUCER_MAX_RETRIES_PER_REQUEST,
} = await import("./connection.server");
const { JOBS_LOG_EVENT } = await import("../observability/log-event");

const URL = "redis://127.0.0.1:6379";

beforeEach(() => {
  instances.length = 0;
  quitBehaviour.fail = false;
  logJobEvent.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("nothing connects at import", () => {
  it("creates no connection until a factory is called", () => {
    expect(instances).toEqual([]);
  });

  it("opens the socket lazily, on the first command", () => {
    createProducerConnection(URL);

    expect(instances[0]?.options.lazyConnect).toBe(true);
  });
});

describe("the producer gives up quickly", () => {
  it("bounds retries per request", () => {
    createProducerConnection(URL);

    expect(instances[0]?.options.maxRetriesPerRequest).toBe(
      PRODUCER_MAX_RETRIES_PER_REQUEST,
    );
    expect(PRODUCER_MAX_RETRIES_PER_REQUEST).toBeGreaterThan(0);
  });

  it("refuses to buffer commands while offline", () => {
    // With buffering on, `queue.add` would resolve into a buffer that is
    // discarded when the process exits, and the dispatcher would mark a row
    // published that was never published.
    createProducerConnection(URL);

    expect(instances[0]?.options.enableOfflineQueue).toBe(false);
  });

  it("bounds the connect timeout", () => {
    createProducerConnection(URL);

    expect(instances[0]?.options.connectTimeout).toBe(JOBS_CONNECT_TIMEOUT_MS);
  });

  it("stops reconnecting after a bounded number of attempts", () => {
    createProducerConnection(URL);

    const retryStrategy = instances[0]?.options.retryStrategy as (
      attempt: number,
    ) => number | null;

    expect(retryStrategy(1)).toBeGreaterThan(0);
    expect(retryStrategy(100)).toBeNull();
  });
});

describe("the worker waits", () => {
  it("disables the client-side retry limit, as BullMQ requires", () => {
    // A consumer sits in a blocking read; a retry limit would abandon it during
    // a brief blip and drop an in-flight job.
    createWorkerConnection(URL);

    expect(instances[0]?.options.maxRetriesPerRequest).toBeNull();
  });

  it("keeps reconnecting, with a bounded delay", () => {
    createWorkerConnection(URL);

    const retryStrategy = instances[0]?.options.retryStrategy as (
      attempt: number,
    ) => number;

    expect(retryStrategy(1)).toBeGreaterThan(0);
    expect(retryStrategy(100)).toBeLessThanOrEqual(3_000);
  });
});

describe("both connections", () => {
  it("set no client-side key prefix, because BullMQ owns its key layout", () => {
    createProducerConnection(URL);
    createWorkerConnection(URL);

    for (const instance of instances) {
      expect(instance.options.keyPrefix).toBe("");
    }
  });

  it("attach an error listener, because an unhandled one ends the process", () => {
    createProducerConnection(URL);
    createWorkerConnection(URL);

    for (const instance of instances) {
      expect(instance.listeners.get("error")).toHaveLength(1);
    }
  });

  it("report a failure by role, with a class name and nothing else", () => {
    createProducerConnection(URL);
    instances[0]?.listeners.get("error")?.[0]?.(
      new Error("connect ECONNREFUSED 127.0.0.1:6379"),
    );

    expect(logJobEvent).toHaveBeenCalledWith(
      "warn",
      JOBS_LOG_EVENT.QUEUE_PRODUCER_CONNECTION_FAILED,
      { errorCode: "Error" },
    );

    createWorkerConnection(URL);
    instances[1]?.listeners.get("error")?.[0]?.("not an error");

    expect(logJobEvent).toHaveBeenLastCalledWith(
      "warn",
      JOBS_LOG_EVENT.QUEUE_WORKER_CONNECTION_FAILED,
      { errorCode: "UnknownError" },
    );
  });

  it("never log the address", () => {
    createProducerConnection("rediss://user:hunter2@queue.example:6380");
    instances[0]?.listeners.get("error")?.[0]?.(new Error("hunter2 refused"));

    const logged = JSON.stringify(logJobEvent.mock.calls);

    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("queue.example");
  });
});

describe("closing", () => {
  it("waits for in-flight commands", async () => {
    const connection = createProducerConnection(URL);

    await expect(closeJobsConnection(connection)).resolves.toBeUndefined();
  });

  it("falls back to dropping a socket that is already gone", async () => {
    // Waiting on a dead socket would only delay a shutdown.
    quitBehaviour.fail = true;

    const connection = createProducerConnection(URL);

    await expect(closeJobsConnection(connection)).resolves.toBeUndefined();
    expect(instances[0]?.listeners.has("disconnected")).toBe(true);
  });
});
