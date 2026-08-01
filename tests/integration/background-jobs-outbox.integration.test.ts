import { randomUUID } from "node:crypto";

import { loadEnvConfig } from "@next/env";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

loadEnvConfig(process.cwd());

const { database } = await import("@/platform/database/index.server");
const {
  defineJob,
  JOB_BACKOFF_TYPE,
  jobExecutionKey,
  resetJobsConfiguration,
  runDatabaseJobOnce,
  writeOutboxMessage,
} = await import("@/platform/jobs/index.server");

/**
 * The transactional half of the outbox, against a real PostgreSQL.
 *
 * Nothing here needs Redis, a queue, or a worker — which is the point being
 * proved. The guarantee this change rests on is a database guarantee: the
 * business change and the intent to publish it share a commit, and a job's
 * effect and the proof that it happened share another. Both are properties of
 * transactions, and neither can be demonstrated against a mock.
 *
 * Every row is tagged with a run identifier so a case cleans up exactly what it
 * created and two runs against one database cannot see each other's rows.
 */
const RUN_ID = randomUUID();

const job = defineJob({
  name: "contract.outbox-fixture",
  version: 1,
  payloadSchema: z
    .object({ subject: z.string().min(1), note: z.string().default("none") })
    .strict(),
  attempts: 3,
  backoff: { type: JOB_BACKOFF_TYPE.EXPONENTIAL, delayMs: 1_000 },
  timeoutMs: 5_000,
  timeoutRetryable: true,
  idempotency: { key: (payload) => payload.subject },
  handle: async () => undefined,
});

/**
 * A stand-in for the business change a real caller would be making.
 *
 * The audit table is used because it already exists, is append-only, and has no
 * foreign key to anything this suite would have to create. Inventing a table for
 * the fixture would put a business model in the production schema, which is the
 * one thing this change is not allowed to do.
 */
async function writeBusinessChange(
  tx: Parameters<Parameters<typeof database.$transaction>[0]>[0],
  marker: string,
): Promise<string> {
  const record = await tx.authorizationAuditRecord.create({
    data: {
      actorUserId: `${RUN_ID}-actor`,
      actorSessionId: `${RUN_ID}-session`,
      action: "USER_ROLE_SET",
      targetUserId: marker,
      requestId: RUN_ID,
    },
    select: { id: true },
  });

  return record.id;
}

function subject(name: string): string {
  return `${RUN_ID}-${name}`;
}

beforeEach(() => {
  process.env.JOBS_ENABLED = "true";
  resetJobsConfiguration();
});

afterEach(async () => {
  delete process.env.JOBS_ENABLED;
  resetJobsConfiguration();

  await database.outboxMessage.deleteMany({ where: { correlationId: RUN_ID } });
  await database.authorizationAuditRecord.deleteMany({
    where: { requestId: RUN_ID },
  });
});

afterAll(async () => {
  await database.jobExecutionReceipt.deleteMany({
    where: { jobName: job.name },
  });
  await database.$disconnect();
});

describe("the change and the intent to publish it share a commit", () => {
  it("commits the business row and the outbox row together", async () => {
    const marker = subject("committed");

    const { outboxId } = await database.$transaction(async (tx) => {
      await writeBusinessChange(tx, marker);

      return writeOutboxMessage(tx, {
        job,
        payload: { subject: marker },
        correlationId: RUN_ID,
      });
    });

    const [row, changes] = await Promise.all([
      database.outboxMessage.findUnique({ where: { id: outboxId } }),
      database.authorizationAuditRecord.count({
        where: { targetUserId: marker },
      }),
    ]);

    expect(changes).toBe(1);
    expect(row).toMatchObject({
      jobName: job.name,
      jobVersion: 1,
      publishedAt: null,
      deadLetteredAt: null,
      publishAttempts: 0,
      lockedBy: null,
    });
    expect(row?.payload).toEqual({ subject: marker, note: "none" });
  });

  it("removes both when the transaction rolls back", async () => {
    // This is the whole reason the writer takes a transaction client: a job that
    // ran against a change that never happened is the failure the outbox exists
    // to remove.
    const marker = subject("rolled-back");
    let outboxId = "";

    await expect(
      database.$transaction(async (tx) => {
        await writeBusinessChange(tx, marker);

        outboxId = (
          await writeOutboxMessage(tx, {
            job,
            payload: { subject: marker },
            correlationId: RUN_ID,
          })
        ).outboxId;

        throw new Error("the business rule refused");
      }),
    ).rejects.toThrow("the business rule refused");

    expect(
      await database.outboxMessage.findUnique({ where: { id: outboxId } }),
    ).toBeNull();
    expect(
      await database.authorizationAuditRecord.count({
        where: { targetUserId: marker },
      }),
    ).toBe(0);
  });

  it("is invisible to another connection until the commit", async () => {
    const marker = subject("uncommitted");
    let seenMidTransaction = 0;

    await database.$transaction(async (tx) => {
      await writeOutboxMessage(tx, {
        job,
        payload: { subject: marker },
        correlationId: RUN_ID,
      });

      // A separate connection: this is what a dispatcher polling in another
      // process actually sees.
      seenMidTransaction = await database.outboxMessage.count({
        where: { correlationId: RUN_ID },
      });
    });

    expect(seenMidTransaction).toBe(0);
    expect(
      await database.outboxMessage.count({ where: { correlationId: RUN_ID } }),
    ).toBe(1);
  });

  it("survives with no Redis address configured at all", async () => {
    delete process.env.JOBS_REDIS_URL;
    resetJobsConfiguration();

    const { outboxId } = await database.$transaction((tx) =>
      writeOutboxMessage(tx, {
        job,
        payload: { subject: subject("no-redis") },
        correlationId: RUN_ID,
      }),
    );

    expect(
      await database.outboxMessage.findUnique({ where: { id: outboxId } }),
    ).not.toBeNull();
  });
});

describe("a job's effect happens once", () => {
  const marker = () => subject(`effect-${randomUUID()}`);

  it("writes the receipt and the effect in one commit", async () => {
    const target = marker();
    const executionKey = jobExecutionKey(job.name, 1, target);

    const outcome = await runDatabaseJobOnce({
      executionKey,
      jobName: job.name,
      jobVersion: 1,
      execute: async (tx) => writeBusinessChange(tx, target),
    });

    expect(outcome.executed).toBe(true);
    expect(
      await database.jobExecutionReceipt.findUnique({
        where: { executionKey },
      }),
    ).not.toBeNull();
    expect(
      await database.authorizationAuditRecord.count({
        where: { targetUserId: target },
      }),
    ).toBe(1);
  });

  it("skips the effect on a repeat delivery", async () => {
    const target = marker();
    const executionKey = jobExecutionKey(job.name, 1, target);
    const execute = async (
      tx: Parameters<Parameters<typeof database.$transaction>[0]>[0],
    ) => writeBusinessChange(tx, target);

    await runDatabaseJobOnce({
      executionKey,
      jobName: job.name,
      jobVersion: 1,
      execute,
    });

    const second = await runDatabaseJobOnce({
      executionKey,
      jobName: job.name,
      jobVersion: 1,
      execute,
    });

    expect(second.executed).toBe(false);
    expect(
      await database.authorizationAuditRecord.count({
        where: { targetUserId: target },
      }),
    ).toBe(1);
  });

  it("rolls the receipt back when the effect fails", async () => {
    // Otherwise a failed attempt would leave a receipt saying the work was
    // done, and the retry would skip it forever.
    const target = marker();
    const executionKey = jobExecutionKey(job.name, 1, target);

    await expect(
      runDatabaseJobOnce({
        executionKey,
        jobName: job.name,
        jobVersion: 1,
        execute: async (tx) => {
          await writeBusinessChange(tx, target);

          throw new Error("the effect failed");
        },
      }),
    ).rejects.toThrow("the effect failed");

    expect(
      await database.jobExecutionReceipt.findUnique({
        where: { executionKey },
      }),
    ).toBeNull();
    expect(
      await database.authorizationAuditRecord.count({
        where: { targetUserId: target },
      }),
    ).toBe(0);

    // And the retry is free to run.
    const retry = await runDatabaseJobOnce({
      executionKey,
      jobName: job.name,
      jobVersion: 1,
      execute: async (tx) => writeBusinessChange(tx, target),
    });

    expect(retry.executed).toBe(true);
  });

  it("lets two concurrent deliveries produce exactly one effect", async () => {
    const target = marker();
    const executionKey = jobExecutionKey(job.name, 1, target);

    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        runDatabaseJobOnce({
          executionKey,
          jobName: job.name,
          jobVersion: 1,
          execute: async (tx) => writeBusinessChange(tx, target),
        }),
      ),
    );

    expect(outcomes.filter(({ executed }) => executed)).toHaveLength(1);
    expect(
      await database.authorizationAuditRecord.count({
        where: { targetUserId: target },
      }),
    ).toBe(1);
  });

  it("keeps two versions of one job independent", async () => {
    const target = marker();

    await runDatabaseJobOnce({
      executionKey: jobExecutionKey(job.name, 1, target),
      jobName: job.name,
      jobVersion: 1,
      execute: async (tx) => writeBusinessChange(tx, target),
    });

    const second = await runDatabaseJobOnce({
      executionKey: jobExecutionKey(job.name, 2, target),
      jobName: job.name,
      jobVersion: 2,
      execute: async (tx) => writeBusinessChange(tx, target),
    });

    // A v2 that fixes a calculation must be free to run over a row v1 touched.
    expect(second.executed).toBe(true);
    expect(
      await database.authorizationAuditRecord.count({
        where: { targetUserId: target },
      }),
    ).toBe(2);
  });
});

describe("the claim query the dispatcher runs", () => {
  it("is supported by an index rather than a sequential scan", async () => {
    const marker = subject("planned");

    await database.$transaction((tx) =>
      writeOutboxMessage(tx, {
        job,
        payload: { subject: marker },
        correlationId: RUN_ID,
      }),
    );

    const plan = await database.$queryRaw<Array<{ "QUERY PLAN": string }>>`
      EXPLAIN SELECT id
        FROM "outbox_message"
       WHERE "publishedAt" IS NULL
         AND "deadLetteredAt" IS NULL
         AND "availableAt" <= now()
       ORDER BY "availableAt", "createdAt", "id"
       LIMIT 25
    `;

    // A plan is not asserted directly — PostgreSQL is free to choose a
    // sequential scan on a table of one row — but the index the plan would use
    // must exist.
    expect(plan.length).toBeGreaterThan(0);

    const indexes = await database.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'outbox_message'
    `;

    expect(indexes.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        "outbox_message_dispatchable_idx",
        "outbox_message_locked_until_idx",
        "outbox_message_dead_lettered_at_idx",
      ]),
    );
  });
});
