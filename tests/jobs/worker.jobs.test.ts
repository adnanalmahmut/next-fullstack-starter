import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { database } from "@/platform/database/index.server";
import {
  createJobRegistry,
  createOutboxDispatcher,
  defineJob,
  JOB_BACKOFF_TYPE,
  JOB_FAILURE_CODE,
  PermanentJobError,
  startJobsWorkerRuntime,
  writeOutboxMessage,
  type JobsWorkerRuntime,
} from "@/platform/jobs/index.server";
import { requireJobQueue } from "@/platform/jobs/queue/job-queue.server";

import {
  cleanupJobsRun,
  configureJobsForTest,
  waitFor,
  type JobQueue,
} from "../fixtures/jobs.fixture";

/**
 * A real worker consuming from a real queue.
 *
 * Retries, backoff, and the failed set are BullMQ behaviours; a timeout that
 * actually aborts a signal is an event-loop behaviour. None of them can be
 * demonstrated against a mock, and all of them are the reason to have a queue at
 * all.
 */
const CORRELATION = `worker-${randomUUID()}`;

configureJobsForTest({
  OUTBOX_BATCH_SIZE: "10",
  OUTBOX_POLL_INTERVAL_MS: "50",
  OUTBOX_LEASE_MS: "2000",
});

const payloadSchema = z.object({ subject: z.string().min(1) }).strict();

/** How many attempts each subject has seen, recorded by the handlers below. */
const attemptsBySubject = new Map<string, number>();
const abortedSubjects = new Set<string>();

function record(subject: string): number {
  const attempt = (attemptsBySubject.get(subject) ?? 0) + 1;

  attemptsBySubject.set(subject, attempt);

  return attempt;
}

const succeeds = defineJob({
  name: "fixture.succeeds",
  version: 1,
  payloadSchema,
  resultSchema: z.object({ attempt: z.number() }).strict(),
  attempts: 2,
  backoff: { type: JOB_BACKOFF_TYPE.FIXED, delayMs: 100 },
  timeoutMs: 2_000,
  timeoutRetryable: true,
  idempotency: { key: (payload) => payload.subject },
  handle: async ({ payload }) => ({ attempt: record(payload.subject) }),
});

const failsTwice = defineJob({
  name: "fixture.fails-twice",
  version: 1,
  payloadSchema,
  attempts: 3,
  backoff: { type: JOB_BACKOFF_TYPE.EXPONENTIAL, delayMs: 100 },
  timeoutMs: 2_000,
  timeoutRetryable: true,
  idempotency: { key: (payload) => payload.subject },
  handle: async ({ payload }) => {
    if (record(payload.subject) < 3) {
      throw new Error("a transient dependency was unavailable");
    }
  },
});

const alwaysFails = defineJob({
  name: "fixture.always-fails",
  version: 1,
  payloadSchema,
  attempts: 2,
  backoff: { type: JOB_BACKOFF_TYPE.FIXED, delayMs: 100 },
  timeoutMs: 2_000,
  timeoutRetryable: true,
  idempotency: { key: (payload) => payload.subject },
  handle: async ({ payload }) => {
    record(payload.subject);

    throw new Error("still unavailable");
  },
});

const permanentlyFails = defineJob({
  name: "fixture.permanent",
  version: 1,
  payloadSchema,
  attempts: 5,
  backoff: { type: JOB_BACKOFF_TYPE.FIXED, delayMs: 100 },
  timeoutMs: 2_000,
  timeoutRetryable: true,
  idempotency: { key: (payload) => payload.subject },
  handle: async ({ payload }) => {
    record(payload.subject);

    throw new PermanentJobError(
      JOB_FAILURE_CODE.HANDLER_FAILED,
      "this message can never succeed",
    );
  },
});

const timesOut = defineJob({
  name: "fixture.times-out",
  version: 1,
  payloadSchema,
  attempts: 1,
  backoff: { type: JOB_BACKOFF_TYPE.FIXED, delayMs: 100 },
  timeoutMs: 150,
  timeoutRetryable: false,
  idempotency: { key: (payload) => payload.subject },
  handle: async ({ payload, signal }) => {
    record(payload.subject);

    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        abortedSubjects.add(payload.subject);
        resolve();
      });
    });
  },
});

const badResult = defineJob({
  name: "fixture.bad-result",
  version: 1,
  payloadSchema,
  resultSchema: z.object({ count: z.number() }).strict(),
  attempts: 3,
  backoff: { type: JOB_BACKOFF_TYPE.FIXED, delayMs: 100 },
  timeoutMs: 2_000,
  timeoutRetryable: true,
  idempotency: { key: (payload) => payload.subject },
  handle: async ({ payload }) => {
    record(payload.subject);

    return { count: "one" } as unknown as { count: number };
  },
});

const registry = createJobRegistry([
  succeeds,
  failsTwice,
  alwaysFails,
  permanentlyFails,
  timesOut,
  badResult,
]);

let runtime: JobsWorkerRuntime;
let queue: JobQueue;

type AnyJob = typeof succeeds | typeof failsTwice;

async function enqueue(
  job: { name: string; version: number; payloadSchema: unknown },
  subject: string,
): Promise<string> {
  const { outboxId } = await database.$transaction((tx) =>
    writeOutboxMessage(tx, {
      job: job as unknown as AnyJob,
      payload: { subject },
      correlationId: CORRELATION,
    }),
  );

  await createOutboxDispatcher({ registry }).runOnce();

  return outboxId;
}

async function waitForState(id: string, state: string) {
  return waitFor(`job ${id} to reach ${state}`, async () => {
    const job = await queue.getJob(id);

    if (!job || (await job.getState()) !== state) {
      return null;
    }

    // Re-read rather than returning the handle fetched a moment ago: the state
    // is what settled, and the snapshot taken before it settled carries neither
    // the return value nor the failure reason.
    return queue.getJob(id);
  });
}

beforeAll(async () => {
  queue = await requireJobQueue();
  await queue.obliterate({ force: true });
  await database.outboxMessage.deleteMany({
    where: { correlationId: CORRELATION },
  });

  runtime = await startJobsWorkerRuntime({ registry, concurrency: 4 });
});

afterAll(async () => {
  await runtime.stop();
  await cleanupJobsRun(CORRELATION);
  await database.$disconnect();
});

describe("a valid message runs", () => {
  it("executes the handler and records the result", async () => {
    const outboxId = await enqueue(succeeds, "ok-1");
    const job = await waitForState(outboxId, "completed");

    expect(attemptsBySubject.get("ok-1")).toBe(1);
    expect(job.returnvalue).toEqual({ attempt: 1 });
  });
});

describe("retries", () => {
  it("retries a transient failure and completes", async () => {
    const outboxId = await enqueue(failsTwice, "retry-1");
    const job = await waitForState(outboxId, "completed");

    expect(attemptsBySubject.get("retry-1")).toBe(3);
    expect(job.attemptsMade).toBe(3);
  }, 20_000);

  it("spaces the attempts out rather than hammering", async () => {
    const started = Date.now();
    const outboxId = await enqueue(failsTwice, "retry-2");

    await waitForState(outboxId, "completed");

    // Exponential from 100ms: at least 100 + 200 between three attempts.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  }, 20_000);

  it("stops at the declared budget and leaves the job inspectable", async () => {
    const outboxId = await enqueue(alwaysFails, "exhausted-1");
    const job = await waitForState(outboxId, "failed");

    expect(attemptsBySubject.get("exhausted-1")).toBe(2);
    // The failed set is the operational dead-letter store, so the job is still
    // there to be looked at and redriven.
    expect(job.failedReason).toBeDefined();
    expect(await queue.getFailedCount()).toBeGreaterThan(0);
  }, 20_000);
});

describe("permanent failures", () => {
  it("are not retried", async () => {
    const outboxId = await enqueue(permanentlyFails, "permanent-1");
    const job = await waitForState(outboxId, "failed");

    expect(attemptsBySubject.get("permanent-1")).toBe(1);
    expect(job.attemptsMade).toBe(1);
  });

  it("record the stable code and not the original message", async () => {
    const outboxId = await enqueue(permanentlyFails, "permanent-2");
    const job = await waitForState(outboxId, "failed");

    // BullMQ serializes the message into Redis, so it must carry a code rather
    // than whatever the handler happened to say.
    expect(job.failedReason).toBe("Job failed permanently: handler-failed");
    expect(job.failedReason).not.toContain("can never succeed");
  });

  it("include a payload that no longer matches its schema", async () => {
    // The row is written raw, as an older release would have left it, so the
    // worker sees a message the definition refuses.
    const row = await database.outboxMessage.create({
      data: {
        jobName: "fixture.succeeds",
        jobVersion: 1,
        payload: { subject: 7 } as never,
        correlationId: CORRELATION,
      },
      select: { id: true },
    });

    // The dispatcher refuses it before it ever reaches the queue.
    await createOutboxDispatcher({ registry }).runOnce();

    const stored = await database.outboxMessage.findUnique({
      where: { id: row.id },
    });

    expect(stored?.deadLetteredAt).not.toBeNull();
    expect(await queue.getJob(row.id)).toBeUndefined();
  });

  it("cover a result that does not match its schema", async () => {
    const outboxId = await enqueue(badResult, "bad-result-1");
    const job = await waitForState(outboxId, "failed");

    // The effect has already happened; retrying would replay it.
    expect(attemptsBySubject.get("bad-result-1")).toBe(1);
    expect(job.failedReason).toBe("Job failed permanently: invalid-result");
  });
});

describe("timeouts", () => {
  it("abort the handler's signal", async () => {
    const outboxId = await enqueue(timesOut, "timeout-1");
    const job = await waitForState(outboxId, "failed");

    expect(abortedSubjects.has("timeout-1")).toBe(true);
    expect(job.failedReason).toBe("Job failed permanently: timed-out");
  }, 20_000);
});
