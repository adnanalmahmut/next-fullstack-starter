import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { database } from "@/platform/database/index.server";
import {
  createJobRegistry,
  createOutboxDispatcher,
  defineJob,
  JOB_BACKOFF_TYPE,
  jobExecutionKey,
  runDatabaseJobOnce,
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
 * At-least-once delivery meeting an exactly-once effect.
 *
 * The queue may deliver a message more than once — after a crash, after a
 * stalled job is requeued, after a lock expires — and this project does not
 * pretend otherwise. What it guarantees is narrower and provable: the database
 * effect happens once, because the receipt that records it is written in the
 * same transaction.
 *
 * These cases run the real thing end to end: a worker, a queue, and PostgreSQL.
 */
const CORRELATION = `idempotency-${randomUUID()}`;
const JOB_NAME = "fixture.idempotent";

configureJobsForTest({
  OUTBOX_BATCH_SIZE: "10",
  OUTBOX_POLL_INTERVAL_MS: "50",
  OUTBOX_LEASE_MS: "2000",
});

/**
 * The audit table stands in for a business effect.
 *
 * It already exists, is append-only, and has no foreign key to anything this
 * suite would have to create. Adding a fixture model to the production schema
 * to make a test read better is the one thing this change must not do.
 */
async function applyEffect(
  tx: Parameters<Parameters<typeof database.$transaction>[0]>[0],
  subject: string,
): Promise<void> {
  await tx.authorizationAuditRecord.create({
    data: {
      actorUserId: `${CORRELATION}-actor`,
      actorSessionId: `${CORRELATION}-session`,
      action: "USER_ROLE_SET",
      targetUserId: subject,
      requestId: CORRELATION,
    },
  });
}

function effectCount(subject: string): Promise<number> {
  return database.authorizationAuditRecord.count({
    where: { targetUserId: subject },
  });
}

const payloadSchema = z.object({ subject: z.string().min(1) }).strict();

/** How many times the handler body ran, as opposed to how many effects landed. */
const deliveries = new Map<string, number>();

const idempotentJob = defineJob({
  name: JOB_NAME,
  version: 1,
  payloadSchema,
  resultSchema: z.object({ executed: z.boolean() }).strict(),
  attempts: 3,
  backoff: { type: JOB_BACKOFF_TYPE.FIXED, delayMs: 100 },
  timeoutMs: 3_000,
  timeoutRetryable: true,
  idempotency: { key: (payload) => payload.subject },
  handle: async ({ payload, context }) => {
    deliveries.set(payload.subject, (deliveries.get(payload.subject) ?? 0) + 1);

    const outcome = await runDatabaseJobOnce({
      executionKey: context.executionKey,
      jobName: context.jobName,
      jobVersion: context.jobVersion,
      execute: async (tx) => applyEffect(tx, payload.subject),
    });

    return { executed: outcome.executed };
  },
});

const registry = createJobRegistry([idempotentJob]);

let runtime: JobsWorkerRuntime;
let queue: JobQueue;

function subject(name: string): string {
  return `${CORRELATION}-${name}`;
}

async function deliver(target: string): Promise<string> {
  const { outboxId } = await database.$transaction((tx) =>
    writeOutboxMessage(tx, {
      job: idempotentJob,
      payload: { subject: target },
      correlationId: CORRELATION,
    }),
  );

  await createOutboxDispatcher({ registry }).runOnce();

  return outboxId;
}

async function waitForCompletion(id: string) {
  return waitFor(`job ${id} to complete`, async () => {
    const job = await queue.getJob(id);

    if (!job || (await job.getState()) !== "completed") {
      return null;
    }

    // Re-read rather than returning the handle fetched a moment ago: the state
    // is what settled, and the snapshot taken before it settled has no return
    // value on it.
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
  await database.authorizationAuditRecord.deleteMany({
    where: { requestId: CORRELATION },
  });
  await database.jobExecutionReceipt.deleteMany({
    where: { jobName: JOB_NAME },
  });
  await database.$disconnect();
});

describe("a repeated delivery", () => {
  it("applies the effect once", async () => {
    const target = subject("repeat");
    const first = await deliver(target);

    await waitForCompletion(first);

    // A second outbox row for the same work: a retried request, a redriven
    // message, an operator republishing by hand. All three are the same
    // operation as far as the domain is concerned.
    const second = await deliver(target);
    const job = await waitForCompletion(second);

    expect(deliveries.get(target)).toBe(2);
    expect(job.returnvalue).toEqual({ executed: false });
    expect(await effectCount(target)).toBe(1);
  }, 20_000);

  it("is recognised by the domain key, not by the transport id", async () => {
    const target = subject("keys");
    const first = await deliver(target);
    const second = await deliver(target);

    await waitForCompletion(first);
    await waitForCompletion(second);

    // Two different outbox ids and two different BullMQ job ids, one effect.
    expect(first).not.toBe(second);
    expect(await effectCount(target)).toBe(1);
  }, 20_000);
});

describe("concurrent deliveries", () => {
  it("apply the effect once even when they race", async () => {
    const target = subject("race");
    const ids = await Promise.all([
      deliver(target),
      deliver(target),
      deliver(target),
      deliver(target),
    ]);

    const jobs = await Promise.all(ids.map((id) => waitForCompletion(id)));
    const executed = jobs.filter(
      ({ returnvalue }) => (returnvalue as { executed: boolean }).executed,
    );

    // The unique index closes the window a check-then-write would leave open.
    expect(executed).toHaveLength(1);
    expect(await effectCount(target)).toBe(1);
  }, 20_000);
});

describe("the receipt and the effect are one commit", () => {
  it("leaves no receipt behind when the effect fails", async () => {
    const target = subject("rollback");
    const executionKey = jobExecutionKey(JOB_NAME, 1, target);

    await expect(
      runDatabaseJobOnce({
        executionKey,
        jobName: JOB_NAME,
        jobVersion: 1,
        execute: async (tx) => {
          await applyEffect(tx, target);

          throw new Error("the effect failed");
        },
      }),
    ).rejects.toThrow("the effect failed");

    expect(
      await database.jobExecutionReceipt.findUnique({
        where: { executionKey },
      }),
    ).toBeNull();
    expect(await effectCount(target)).toBe(0);
  });

  it("lets the retry that follows apply the effect", async () => {
    const target = subject("retry-after-rollback");
    const outboxId = await deliver(target);
    const job = await waitForCompletion(outboxId);

    expect(job.returnvalue).toEqual({ executed: true });
    expect(await effectCount(target)).toBe(1);
  }, 20_000);

  it("stops a replay once the receipt exists", async () => {
    const target = subject("replayed");
    const executionKey = jobExecutionKey(JOB_NAME, 1, target);

    await database.jobExecutionReceipt.create({
      data: { executionKey, jobName: JOB_NAME, jobVersion: 1 },
    });

    const outboxId = await deliver(target);
    const job = await waitForCompletion(outboxId);

    expect(job.returnvalue).toEqual({ executed: false });
    expect(await effectCount(target)).toBe(0);
  }, 20_000);
});
