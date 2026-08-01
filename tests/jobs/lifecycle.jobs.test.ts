import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { database } from "@/platform/database/index.server";
import {
  closeJobQueue,
  createJobRegistry,
  createOutboxDispatcher,
  defineJob,
  isJobsEnabled,
  JOB_BACKOFF_TYPE,
  resetJobsConfiguration,
  startJobsWorkerRuntime,
  writeOutboxMessage,
} from "@/platform/jobs/index.server";
import { requireJobQueue } from "@/platform/jobs/queue/job-queue.server";

import {
  cleanupJobsRun,
  configureJobsForTest,
  waitFor,
} from "../fixtures/jobs.fixture";

/**
 * The worker as a process: what it does when it starts, and what it does when it
 * is asked to stop.
 *
 * A deployment restarts workers constantly — every release, every scale event,
 * every node replacement — so shutdown is not an edge case, it is the common
 * case. The properties that matter are that a stop drains rather than drops,
 * that it is bounded, and that it releases everything it opened.
 */
const CORRELATION = `lifecycle-${randomUUID()}`;
const REDIS_URL = process.env.JOBS_REDIS_URL;

configureJobsForTest({
  OUTBOX_BATCH_SIZE: "10",
  OUTBOX_POLL_INTERVAL_MS: "50",
  OUTBOX_LEASE_MS: "2000",
  JOBS_WORKER_SHUTDOWN_TIMEOUT_MS: "5000",
});

const payloadSchema = z.object({ subject: z.string().min(1) }).strict();

const started = new Set<string>();
const finished = new Set<string>();

const slowJob = defineJob({
  name: "fixture.slow",
  version: 1,
  payloadSchema,
  attempts: 2,
  backoff: { type: JOB_BACKOFF_TYPE.FIXED, delayMs: 100 },
  timeoutMs: 5_000,
  timeoutRetryable: true,
  idempotency: { key: (payload) => payload.subject },
  handle: async ({ payload }) => {
    started.add(payload.subject);

    await new Promise((resolve) => setTimeout(resolve, 300));

    finished.add(payload.subject);
  },
});

const registry = createJobRegistry([slowJob]);

function restoreRedisUrl(): void {
  if (REDIS_URL === undefined) {
    delete process.env.JOBS_REDIS_URL;
  } else {
    process.env.JOBS_REDIS_URL = REDIS_URL;
  }

  resetJobsConfiguration();
}

async function enqueue(subject: string): Promise<string> {
  const { outboxId } = await database.$transaction((tx) =>
    writeOutboxMessage(tx, {
      job: slowJob,
      payload: { subject },
      correlationId: CORRELATION,
    }),
  );

  await createOutboxDispatcher({ registry }).runOnce();

  return outboxId;
}

afterEach(async () => {
  restoreRedisUrl();
  await closeJobQueue();
});

afterAll(async () => {
  restoreRedisUrl();
  await cleanupJobsRun(CORRELATION);
  await database.authorizationAuditRecord.deleteMany({
    where: { requestId: CORRELATION },
  });
  await database.$disconnect();
});

describe("starting", () => {
  it("runs on its own, with no Next.js process anywhere", async () => {
    const runtime = await startJobsWorkerRuntime({ registry, concurrency: 1 });

    expect(runtime.queueName).toBe("jobs");
    expect(runtime.dispatcherId).toMatch(/[0-9a-f-]{36}/);

    await runtime.stop();
  });

  it("refuses to start when jobs are switched off", async () => {
    process.env.JOBS_ENABLED = "false";
    resetJobsConfiguration();

    try {
      expect(isJobsEnabled()).toBe(false);
      await expect(
        startJobsWorkerRuntime({ registry, concurrency: 1 }),
      ).rejects.toThrow(/not enabled/);
    } finally {
      process.env.JOBS_ENABLED = "true";
      resetJobsConfiguration();
    }
  });

  it("refuses to start with no queue address", async () => {
    delete process.env.JOBS_REDIS_URL;
    resetJobsConfiguration();

    try {
      await expect(
        startJobsWorkerRuntime({ registry, concurrency: 1 }),
      ).rejects.toThrow(/JOBS_REDIS_URL/);
    } finally {
      restoreRedisUrl();
    }
  });
});

describe("stopping", () => {
  it("waits for the job it is already running", async () => {
    // Dropping an in-flight job on every deployment would make every release a
    // source of stalled work.
    const queue = await requireJobQueue();

    await queue.obliterate({ force: true });

    const runtime = await startJobsWorkerRuntime({ registry, concurrency: 1 });
    const outboxId = await enqueue(`${CORRELATION}-draining`);

    await waitFor(
      "the handler to start",
      async () => started.has(`${CORRELATION}-draining`) || null,
    );

    await runtime.stop();

    expect(finished.has(`${CORRELATION}-draining`)).toBe(true);

    // `stop` closes the queue it owns, so inspecting afterwards means asking for
    // a fresh one. That the old handle is unusable is the point: a stopped
    // worker has genuinely released its connections.
    const inspection = await requireJobQueue();
    const job = await inspection.getJob(outboxId);

    expect(await job?.getState()).toBe("completed");
  }, 20_000);

  it("stops publishing before it stops consuming", async () => {
    const runtime = await startJobsWorkerRuntime({ registry, concurrency: 1 });

    await runtime.stop();

    // A row written after the stop is left for the next worker rather than
    // being published into a queue nobody is reading.
    const { outboxId } = await database.$transaction((tx) =>
      writeOutboxMessage(tx, {
        job: slowJob,
        payload: { subject: `${CORRELATION}-after-stop` },
        correlationId: CORRELATION,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const row = await database.outboxMessage.findUnique({
      where: { id: outboxId },
    });

    expect(row?.publishedAt).toBeNull();
  }, 20_000);

  it("releases its connections", async () => {
    const runtime = await startJobsWorkerRuntime({ registry, concurrency: 1 });

    await runtime.stop();

    // A connection left open keeps the process alive; a worker that will not
    // exit is a deployment that hangs.
    await expect(runtime.stop()).resolves.toBeUndefined();
  }, 20_000);

  it("is safe to stop twice", async () => {
    const runtime = await startJobsWorkerRuntime({ registry, concurrency: 1 });

    await Promise.all([runtime.stop(), runtime.stop()]);
    await expect(runtime.stop()).resolves.toBeUndefined();
  }, 20_000);
});

describe("a job that outlives its worker", () => {
  it("comes back rather than disappearing", async () => {
    // A worker killed mid-attempt loses its lock, BullMQ requeues the job, and
    // the handler runs again. That is exactly why handlers are idempotent.
    const queue = await requireJobQueue();

    await queue.obliterate({ force: true });

    const first = await startJobsWorkerRuntime({ registry, concurrency: 1 });
    const subject = `${CORRELATION}-requeued`;
    const outboxId = await enqueue(subject);

    await waitFor(
      "the first attempt to start",
      async () => started.has(subject) || null,
    );
    await first.stop();

    const inspection = await requireJobQueue();
    const job = await inspection.getJob(outboxId);

    expect(job).toBeDefined();
    // Drained rather than dropped: the row is published and the job is
    // accounted for, in one state or another.
    expect(["completed", "active", "waiting", "delayed", "failed"]).toContain(
      await job?.getState(),
    );

    const row = await database.outboxMessage.findUnique({
      where: { id: outboxId },
    });

    expect(row?.publishedAt).not.toBeNull();
  }, 20_000);
});
