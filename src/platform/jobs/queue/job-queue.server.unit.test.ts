import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeQueue = {
  name: string;
  options: Record<string, unknown>;
  closed: boolean;
};

const { queues, connections, queueCloseBehaviour } = vi.hoisted(() => ({
  queues: [] as FakeQueue[],
  connections: [] as string[],
  queueCloseBehaviour: { fail: false },
}));

vi.mock("bullmq", () => ({
  Queue: class {
    closed = false;

    constructor(
      readonly name: string,
      readonly options: Record<string, unknown>,
    ) {
      queues.push(this as unknown as FakeQueue);
    }

    async close() {
      if (queueCloseBehaviour.fail) {
        throw new Error("the queue would not close");
      }

      this.closed = true;
    }
  },
}));

vi.mock("./connection.server", () => ({
  createProducerConnection: (url: string) => {
    connections.push(url);

    return { url };
  },
  closeJobsConnection: vi.fn(async () => undefined),
}));

const {
  closeJobQueue,
  COMPLETED_JOB_RETENTION,
  FAILED_JOB_RETENTION,
  getJobQueue,
  jobOptionsFor,
  jobQueuePrefix,
  JOBS_QUEUE_NAME,
  requireJobQueue,
} = await import("./job-queue.server");
const { closeJobsConnection } = await import("./connection.server");
const { resetJobsConfiguration } = await import("../config/jobs-config");
const { JOB_BACKOFF_TYPE } = await import("../definitions/define-job");

beforeEach(async () => {
  await closeJobQueue();
  queues.length = 0;
  connections.length = 0;
  queueCloseBehaviour.fail = false;
  delete process.env.JOBS_ENABLED;
  delete process.env.JOBS_REDIS_URL;
  process.env.JOBS_TEST_RUN_ID = "unit-run";
  resetJobsConfiguration();
  vi.mocked(closeJobsConnection).mockClear();
});

afterEach(async () => {
  await closeJobQueue();
  delete process.env.JOBS_ENABLED;
  delete process.env.JOBS_REDIS_URL;
  delete process.env.JOBS_TEST_RUN_ID;
  resetJobsConfiguration();
});

function enable(): void {
  process.env.JOBS_ENABLED = "true";
  process.env.JOBS_REDIS_URL = "redis://127.0.0.1:6379";
  resetJobsConfiguration();
}

describe("the queue is built only when it is configured", () => {
  it("answers null with jobs disabled, and builds nothing", async () => {
    await expect(getJobQueue()).resolves.toBeNull();
    expect(queues).toEqual([]);
    expect(connections).toEqual([]);
  });

  it("answers null with jobs enabled but no address", async () => {
    process.env.JOBS_ENABLED = "true";
    resetJobsConfiguration();

    await expect(getJobQueue()).resolves.toBeNull();
    expect(queues).toEqual([]);
  });

  it("refuses rather than answering null when a caller demands one", async () => {
    // A dispatcher that treated an outage as a deliberate absence would quietly
    // stop publishing.
    await expect(requireJobQueue()).rejects.toThrow(/not enabled/);
  });

  it("builds one queue under the configured prefix", async () => {
    enable();

    const queue = await getJobQueue();

    expect(queue).not.toBeNull();
    expect(queues).toHaveLength(1);
    expect(queues[0]?.name).toBe(JOBS_QUEUE_NAME);
    expect(queues[0]?.options.prefix).toBe(jobQueuePrefix());
    expect(jobQueuePrefix()).toContain("unit-run");
  });

  it("reuses the one queue and its one connection", async () => {
    enable();

    const first = await requireJobQueue();
    const second = await requireJobQueue();

    expect(second).toBe(first);
    expect(queues).toHaveLength(1);
    expect(connections).toHaveLength(1);
  });
});

describe("the options a message is published with", () => {
  it("come from the definition, not from the call site", () => {
    const options = jobOptionsFor("o-1", 5, {
      type: JOB_BACKOFF_TYPE.EXPONENTIAL,
      delayMs: 2_000,
    });

    expect(options.jobId).toBe("o-1");
    expect(options.attempts).toBe(5);
    expect(options.backoff).toEqual({ type: "exponential", delay: 2_000 });
  });

  it("keep completed jobs far longer than an outbox lease", () => {
    // The retention is load-bearing: a completed job that still exists is what
    // stops a crash between `queue.add` and the `publishedAt` update from
    // running the work twice.
    expect(COMPLETED_JOB_RETENTION.age).toBeGreaterThanOrEqual(60 * 60);
    expect(COMPLETED_JOB_RETENTION.count).toBeGreaterThan(0);
  });

  it("never remove a failed job on failure", () => {
    // The failed set is the operational dead-letter store.
    const options = jobOptionsFor("o-1", 1, {
      type: JOB_BACKOFF_TYPE.FIXED,
      delayMs: 100,
    });

    expect(options.removeOnFail).not.toBe(true);
    expect(FAILED_JOB_RETENTION.age).toBeGreaterThan(
      COMPLETED_JOB_RETENTION.age,
    );
    expect(FAILED_JOB_RETENTION.count).toBeGreaterThan(
      COMPLETED_JOB_RETENTION.count,
    );
  });
});

describe("closing", () => {
  it("closes the queue and the connection it owns", async () => {
    enable();

    await requireJobQueue();
    await closeJobQueue();

    expect(queues[0]?.closed).toBe(true);
    expect(closeJobsConnection).toHaveBeenCalledTimes(1);
  });

  it("still releases the connection when the queue will not close", async () => {
    enable();
    await requireJobQueue();
    queueCloseBehaviour.fail = true;

    await expect(closeJobQueue()).resolves.toBeUndefined();
    expect(closeJobsConnection).toHaveBeenCalledTimes(1);
  });

  it("is safe to call when nothing was ever built", async () => {
    await expect(closeJobQueue()).resolves.toBeUndefined();
    expect(closeJobsConnection).not.toHaveBeenCalled();
  });

  it("builds a fresh queue after a close", async () => {
    enable();

    const first = await requireJobQueue();

    await closeJobQueue();

    expect(await requireJobQueue()).not.toBe(first);
    expect(connections).toHaveLength(2);
  });
});
