import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { database } from "@/platform/database/index.server";
import {
  closeJobQueue,
  createJobRegistry,
  createOutboxDispatcher,
  defineJob,
  JOB_BACKOFF_TYPE,
  OUTBOX_DEAD_LETTER_CODE,
  resetJobsConfiguration,
  writeOutboxMessage,
} from "@/platform/jobs/index.server";
import { requireJobQueue } from "@/platform/jobs/queue/job-queue.server";

import {
  cleanupJobsRun,
  configureJobsForTest,
  readOutboxRow,
  waitFor,
} from "../fixtures/jobs.fixture";

/**
 * The dispatcher against a real PostgreSQL and a real Redis.
 *
 * What is being tested here cannot be tested anywhere else: `FOR UPDATE SKIP
 * LOCKED` is a PostgreSQL behaviour, and BullMQ's refusal to create a second job
 * under an existing job id is a Redis behaviour. A mock of either would only
 * confirm what the mock was told to do.
 */
const CORRELATION = `dispatcher-${randomUUID()}`;
const REDIS_URL = process.env.JOBS_REDIS_URL;

configureJobsForTest({
  OUTBOX_BATCH_SIZE: "10",
  OUTBOX_POLL_INTERVAL_MS: "50",
  OUTBOX_LEASE_MS: "2000",
  OUTBOX_MAX_PUBLISH_ATTEMPTS: "2",
  OUTBOX_BACKOFF_BASE_MS: "100",
});

const payloadSchema = z.object({ subject: z.string().min(1) }).strict();

const publishable = defineJob({
  name: "fixture.dispatch",
  version: 1,
  payloadSchema,
  attempts: 2,
  backoff: { type: JOB_BACKOFF_TYPE.FIXED, delayMs: 100 },
  timeoutMs: 1_000,
  timeoutRetryable: true,
  idempotency: { key: (payload) => payload.subject },
  handle: async () => undefined,
});

const versionedV2 = defineJob({
  name: "fixture.versioned",
  version: 2,
  payloadSchema,
  attempts: 1,
  backoff: { type: JOB_BACKOFF_TYPE.FIXED, delayMs: 100 },
  timeoutMs: 1_000,
  timeoutRetryable: true,
  idempotency: { key: (payload) => payload.subject },
  handle: async () => undefined,
});

const registry = createJobRegistry([publishable, versionedV2]);

async function seedRow(subject: string, availableAt?: Date): Promise<string> {
  const { outboxId } = await database.$transaction((tx) =>
    writeOutboxMessage(tx, {
      job: publishable,
      payload: { subject },
      correlationId: CORRELATION,
      ...(availableAt === undefined ? {} : { availableAt }),
    }),
  );

  return outboxId;
}

/** A row written by an older release, which no definition can describe today. */
async function seedRawRow(
  jobName: string,
  jobVersion: number,
  payload: unknown,
): Promise<string> {
  const row = await database.outboxMessage.create({
    data: {
      jobName,
      jobVersion,
      payload: payload as never,
      correlationId: CORRELATION,
    },
    select: { id: true },
  });

  return row.id;
}

beforeEach(async () => {
  await database.outboxMessage.deleteMany({
    where: { correlationId: CORRELATION },
  });
});

afterAll(async () => {
  await cleanupJobsRun(CORRELATION);
  await database.$disconnect();
});

describe("publishing", () => {
  it("publishes a pending row and marks it", async () => {
    const outboxId = await seedRow("first");
    const summary = await createOutboxDispatcher({ registry }).runOnce();

    expect(summary).toMatchObject({ claimed: 1, published: 1 });

    const row = await readOutboxRow(outboxId);

    expect(row?.publishedAt).not.toBeNull();
    expect(row?.lockedBy).toBeNull();
    expect(row?.publishAttempts).toBe(1);

    const queue = await requireJobQueue();
    const job = await queue.getJob(outboxId);

    // The BullMQ job id is the outbox row id, which is what makes a republish
    // after a crash idempotent.
    expect(job?.id).toBe(outboxId);
    expect(job?.name).toBe("fixture.dispatch.v1");
    expect(job?.data).toMatchObject({
      jobName: "fixture.dispatch",
      version: 1,
      payload: { subject: "first" },
      outboxId,
      correlationId: CORRELATION,
    });
  });

  it("does not publish a row twice", async () => {
    await seedRow("once");

    const dispatcher = createOutboxDispatcher({ registry });

    expect(await dispatcher.runOnce()).toMatchObject({ published: 1 });
    expect(await dispatcher.runOnce()).toMatchObject({
      claimed: 0,
      published: 0,
    });
  });

  it("leaves a row whose time has not come", async () => {
    const outboxId = await seedRow("later", new Date(Date.now() + 60_000));

    expect(await createOutboxDispatcher({ registry }).runOnce()).toMatchObject({
      claimed: 0,
    });
    expect((await readOutboxRow(outboxId))?.publishedAt).toBeNull();
  });

  it("publishes each row exactly once with two dispatchers running", async () => {
    // `SKIP LOCKED` is the whole reason two dispatchers need no coordination:
    // each simply walks past the rows the other is holding.
    const ids = await Promise.all(
      Array.from({ length: 8 }, (_value, index) => seedRow(`race-${index}`)),
    );

    const [first, second] = await Promise.all([
      createOutboxDispatcher({ registry, dispatcherId: "alpha" }).runOnce(),
      createOutboxDispatcher({ registry, dispatcherId: "beta" }).runOnce(),
    ]);

    expect(first.published + second.published).toBe(8);
    expect(first.claimed + second.claimed).toBe(8);

    const rows = await database.outboxMessage.findMany({
      where: { id: { in: ids } },
      select: { publishedAt: true, publishAttempts: true },
    });

    expect(rows).toHaveLength(8);
    expect(rows.every(({ publishedAt }) => publishedAt !== null)).toBe(true);
    // Claimed once each: a second claim would have incremented the counter.
    expect(rows.every(({ publishAttempts }) => publishAttempts === 1)).toBe(
      true,
    );
  });

  it("recovers a lease abandoned by a dispatcher that died", async () => {
    const outboxId = await seedRow("abandoned");

    await database.outboxMessage.update({
      where: { id: outboxId },
      data: {
        lockedBy: "a-dispatcher-that-is-gone",
        lockedUntil: new Date(Date.now() - 60_000),
        publishAttempts: 1,
      },
    });

    expect(await createOutboxDispatcher({ registry }).runOnce()).toMatchObject({
      published: 1,
    });
    expect((await readOutboxRow(outboxId))?.publishedAt).not.toBeNull();
  });

  it("does not touch a row whose lease is still live", async () => {
    const outboxId = await seedRow("held");

    await database.outboxMessage.update({
      where: { id: outboxId },
      data: {
        lockedBy: "another-dispatcher",
        lockedUntil: new Date(Date.now() + 60_000),
      },
    });

    expect(await createOutboxDispatcher({ registry }).runOnce()).toMatchObject({
      claimed: 0,
    });
  });
});

describe("the crash window", () => {
  it("does not create a second job when the row is republished", async () => {
    // The gap between `queue.add` succeeding and `publishedAt` being written is
    // real. A process that dies inside it leaves a row that looks unpublished
    // and a job that exists.
    const outboxId = await seedRow("crashed");
    const dispatcher = createOutboxDispatcher({ registry });

    await dispatcher.runOnce();

    const queue = await requireJobQueue();
    const original = await queue.getJob(outboxId);

    expect(original).toBeDefined();

    // Reproduce the crash: the job is in Redis, the row still says pending.
    await database.outboxMessage.update({
      where: { id: outboxId },
      data: { publishedAt: null, lockedBy: null, lockedUntil: null },
    });

    await dispatcher.runOnce();

    const jobs = await queue.getJobs(["waiting", "delayed", "active"]);
    const duplicates = jobs.filter(({ id }) => id === outboxId);

    // BullMQ refuses a second job under an existing id, so the republish is a
    // no-op rather than a duplicate delivery. Delivery is still at-least-once
    // once the retained job is evicted, which is why handlers are idempotent.
    expect(duplicates).toHaveLength(1);
    expect((await readOutboxRow(outboxId))?.publishedAt).not.toBeNull();
  });
});

describe("poison messages", () => {
  it.each([
    {
      name: "an unknown job",
      seed: () => seedRawRow("fixture.forgotten", 1, { subject: "x" }),
      code: OUTBOX_DEAD_LETTER_CODE.UNKNOWN_JOB,
    },
    {
      name: "an unsupported version",
      seed: () => seedRawRow("fixture.versioned", 1, { subject: "x" }),
      code: OUTBOX_DEAD_LETTER_CODE.UNSUPPORTED_VERSION,
    },
    {
      name: "a payload the schema refuses",
      seed: () => seedRawRow("fixture.dispatch", 1, { subject: 7 }),
      code: OUTBOX_DEAD_LETTER_CODE.INVALID_PAYLOAD,
    },
  ])("dead-letters $name and keeps the row", async ({ seed, code }) => {
    const outboxId = await seed();
    const summary = await createOutboxDispatcher({ registry }).runOnce();

    expect(summary).toMatchObject({ deadLettered: 1, published: 0 });

    const row = await readOutboxRow(outboxId);

    expect(row?.deadLetterCode).toBe(code);
    expect(row?.deadLetteredAt).not.toBeNull();
    expect(row?.publishedAt).toBeNull();

    const queue = await requireJobQueue();

    expect(await queue.getJob(outboxId)).toBeUndefined();
  });

  it("does not claim a dead-lettered row again", async () => {
    await seedRawRow("fixture.forgotten", 1, { subject: "x" });

    const dispatcher = createOutboxDispatcher({ registry });

    await dispatcher.runOnce();

    expect(await dispatcher.runOnce()).toMatchObject({ claimed: 0 });
  });
});

describe("when Redis is unreachable", () => {
  it("leaves the row pending, backs it off, and records a code", async () => {
    // The durable source is PostgreSQL. Losing Redis must cost delivery time,
    // never a row.
    const outboxId = await seedRow("unreachable");

    await closeJobQueue();
    process.env.JOBS_REDIS_URL = "redis://127.0.0.1:1";
    resetJobsConfiguration();

    try {
      const summary = await createOutboxDispatcher({ registry }).runOnce();

      expect(summary).toMatchObject({ claimed: 1, published: 0, failed: 1 });

      const row = await readOutboxRow(outboxId);

      expect(row?.publishedAt).toBeNull();
      expect(row?.deadLetteredAt).toBeNull();
      expect(row?.lastErrorCode).toBe("publish-failed");
      expect(row?.availableAt.getTime()).toBeGreaterThan(Date.now());
      expect(row?.lockedBy).toBeNull();
    } finally {
      await closeJobQueue();

      if (REDIS_URL === undefined) {
        delete process.env.JOBS_REDIS_URL;
      } else {
        process.env.JOBS_REDIS_URL = REDIS_URL;
      }

      resetJobsConfiguration();
    }
  }, 20_000);

  it("dead-letters only once the attempt budget is spent", async () => {
    const outboxId = await seedRow("exhausted");

    await database.outboxMessage.update({
      where: { id: outboxId },
      data: { publishAttempts: 1 },
    });

    await closeJobQueue();
    process.env.JOBS_REDIS_URL = "redis://127.0.0.1:1";
    resetJobsConfiguration();

    try {
      expect(
        await createOutboxDispatcher({ registry }).runOnce(),
      ).toMatchObject({ deadLettered: 1 });

      const row = await readOutboxRow(outboxId);

      expect(row?.deadLetterCode).toBe(
        OUTBOX_DEAD_LETTER_CODE.PUBLISH_ATTEMPTS_EXHAUSTED,
      );
      // The row is kept, not deleted: "what happened to that message" must
      // always have an answer.
      expect(row?.payload).toEqual({ subject: "exhausted" });
    } finally {
      await closeJobQueue();

      if (REDIS_URL === undefined) {
        delete process.env.JOBS_REDIS_URL;
      } else {
        process.env.JOBS_REDIS_URL = REDIS_URL;
      }

      resetJobsConfiguration();
    }
  }, 20_000);

  it("publishes the backlog once Redis returns", async () => {
    const outboxId = await seedRow("recovered", new Date(Date.now() - 1_000));

    await waitFor("the queue to accept the backlog", async () => {
      const summary = await createOutboxDispatcher({ registry }).runOnce();

      return summary.published === 1 || null;
    });

    expect((await readOutboxRow(outboxId))?.publishedAt).not.toBeNull();
  });
});
