import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

type ClaimedRow = {
  id: string;
  jobName: string;
  jobVersion: number;
  payload: unknown;
  correlationId: string;
  causationId: string | null;
  traceparent: string | null;
  tracestate: string | null;
  occurredAt: Date;
  publishAttempts: number;
};

const { state, queryRaw, updateMany, transaction, add, requireJobQueue } =
  vi.hoisted(() => {
    const rows = { next: [] as unknown[], updateCount: 1 };
    const queryRawMock = vi.fn(async () => rows.next);
    const updateManyMock = vi.fn(async () => ({ count: rows.updateCount }));
    const transactionMock = vi.fn(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ $queryRaw: queryRawMock }),
    );
    const addMock = vi.fn(async () => ({ id: "queued" }));

    return {
      state: rows,
      queryRaw: queryRawMock,
      updateMany: updateManyMock,
      transaction: transactionMock,
      add: addMock,
      requireJobQueue: vi.fn(async () => ({ add: addMock })),
    };
  });

vi.mock("@/platform/database/index.server", () => ({
  database: {
    $transaction: transaction,
    outboxMessage: { updateMany },
  },
}));

vi.mock("../queue/job-queue.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireJobQueue,
}));

const { logJobEvent } = vi.hoisted(() => ({ logJobEvent: vi.fn() }));

vi.mock("../observability/job-logger.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logJobEvent,
}));

const { resetJobsConfiguration } = await import("../config/jobs-config");
const { defineJob, JOB_BACKOFF_TYPE } =
  await import("../definitions/define-job");
const { createJobRegistry } = await import("../definitions/job-registry");
const { JOBS_LOG_EVENT } = await import("../observability/log-event");
const { MAX_JOB_PAYLOAD_BYTES } = await import("../definitions/job-envelope");
const { createOutboxDispatcher } = await import("./outbox-dispatcher.server");
const { OUTBOX_DEAD_LETTER_CODE, OUTBOX_ERROR_CODE } =
  await import("./outbox-message");

const job = defineJob({
  name: "identity.user-deleted",
  version: 1,
  payloadSchema: z.object({ userId: z.string().min(1) }).strict(),
  attempts: 4,
  backoff: { type: JOB_BACKOFF_TYPE.EXPONENTIAL, delayMs: 2_000 },
  timeoutMs: 5_000,
  timeoutRetryable: true,
  idempotency: { key: (payload) => payload.userId },
  handle: async () => undefined,
});

const registry = createJobRegistry([job]);

function row(overrides: Partial<ClaimedRow> = {}): ClaimedRow {
  return {
    id: "0193f0a1-0000-7000-8000-000000000000",
    jobName: "identity.user-deleted",
    jobVersion: 1,
    payload: { userId: "u-1" },
    correlationId: "c-1",
    causationId: null,
    traceparent: null,
    tracestate: null,
    occurredAt: new Date("2026-08-01T12:00:00.000Z"),
    publishAttempts: 1,
    ...overrides,
  };
}

/**
 * The recorded arguments of a mock declared without a parameter list are typed as
 * an empty tuple, so every reader here goes through one narrowing helper rather
 * than casting at each call site.
 */
function recordedCalls(mock: { mock: { calls: unknown[] } }): unknown[][] {
  return mock.mock.calls as unknown[][];
}

function updates(): Record<string, unknown>[] {
  return recordedCalls(updateMany).map(
    (call) => (call[0] as { data: Record<string, unknown> }).data,
  );
}

function events(): string[] {
  return logJobEvent.mock.calls.map((call) => String(call[1]));
}

beforeEach(() => {
  state.next = [];
  state.updateCount = 1;
  queryRaw.mockClear();
  updateMany.mockClear();
  transaction.mockClear();
  add.mockClear();
  add.mockResolvedValue({ id: "queued" });
  requireJobQueue.mockClear();
  requireJobQueue.mockResolvedValue({ add });
  logJobEvent.mockClear();

  process.env.JOBS_ENABLED = "true";
  process.env.JOBS_REDIS_URL = "redis://127.0.0.1:6379";
  process.env.OUTBOX_MAX_PUBLISH_ATTEMPTS = "3";
  process.env.OUTBOX_BACKOFF_BASE_MS = "1000";
  resetJobsConfiguration();
});

afterEach(() => {
  delete process.env.JOBS_ENABLED;
  delete process.env.JOBS_REDIS_URL;
  delete process.env.OUTBOX_MAX_PUBLISH_ATTEMPTS;
  delete process.env.OUTBOX_BACKOFF_BASE_MS;
  resetJobsConfiguration();
});

describe("nothing happens without a configured queue", () => {
  it("claims nothing when jobs are disabled", async () => {
    process.env.JOBS_ENABLED = "false";
    resetJobsConfiguration();

    const dispatcher = createOutboxDispatcher({ registry });

    await expect(dispatcher.runOnce()).resolves.toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
      deadLettered: 0,
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("the claim", () => {
  it("runs in its own short transaction, before any Redis call", async () => {
    state.next = [row()];

    await createOutboxDispatcher({ registry }).runOnce();

    // A network call inside a transaction holds row locks for the duration of
    // somebody else's outage.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.invocationCallOrder[0]).toBeLessThan(
      requireJobQueue.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("skips rows another dispatcher holds and orders the backlog", async () => {
    state.next = [];

    await createOutboxDispatcher({ registry }).runOnce();

    const sql = (recordedCalls(queryRaw)[0]?.[0] as string[]).join(" ");

    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain('ORDER BY c."availableAt", c."createdAt", c."id"');
    expect(sql).toContain('c."publishedAt" IS NULL');
    expect(sql).toContain('c."deadLetteredAt" IS NULL');
    expect(sql).toContain('"publishAttempts" = m."publishAttempts" + 1');
  });

  it("does nothing more when the backlog is empty", async () => {
    state.next = [];

    await expect(
      createOutboxDispatcher({ registry }).runOnce(),
    ).resolves.toMatchObject({ claimed: 0 });
    expect(requireJobQueue).not.toHaveBeenCalled();
  });
});

describe("publishing", () => {
  it("uses the outbox row id as the queue job id", async () => {
    // That is what makes a republish after a crash idempotent for as long as
    // the completed job is retained.
    state.next = [row()];

    await createOutboxDispatcher({ registry }).runOnce();

    expect(add).toHaveBeenCalledWith(
      "identity.user-deleted.v1",
      expect.objectContaining({ outboxId: row().id }),
      expect.objectContaining({ jobId: row().id, attempts: 4 }),
    );
  });

  it("sends an envelope with identity and payload, and nothing else", async () => {
    state.next = [
      row({
        causationId: "cause-1",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      }),
    ];

    await createOutboxDispatcher({ registry }).runOnce();

    expect(recordedCalls(add)[0]?.[1]).toEqual({
      jobName: "identity.user-deleted",
      version: 1,
      payload: { userId: "u-1" },
      outboxId: row().id,
      correlationId: "c-1",
      causationId: "cause-1",
      occurredAt: "2026-08-01T12:00:00.000Z",
      traceContext: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    });
  });

  it("marks the row published and clears the lease", async () => {
    state.next = [row()];

    const summary = await createOutboxDispatcher({ registry }).runOnce();

    expect(summary).toEqual({
      claimed: 1,
      published: 1,
      failed: 0,
      deadLettered: 0,
    });
    expect(updates()[0]).toMatchObject({
      lockedBy: null,
      lockedUntil: null,
      lastErrorCode: null,
      publishedAt: expect.any(Date),
    });
  });

  it("notices when another dispatcher published the row first", async () => {
    state.next = [row()];
    state.updateCount = 0;

    await createOutboxDispatcher({ registry }).runOnce();

    expect(JSON.stringify(logJobEvent.mock.calls)).toContain(
      OUTBOX_ERROR_CODE.LEASE_LOST,
    );
  });
});

describe("when publishing fails", () => {
  it("reschedules with a backoff and records a sanitized code", async () => {
    state.next = [row({ publishAttempts: 2 })];
    add.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:6379"));

    const summary = await createOutboxDispatcher({ registry }).runOnce();

    expect(summary).toMatchObject({ failed: 1, published: 0 });

    const data = updates()[0];

    expect(data?.lockedBy).toBeNull();
    expect(data?.lastErrorCode).toBe(OUTBOX_ERROR_CODE.PUBLISH_FAILED);
    expect(data?.availableAt).toBeInstanceOf(Date);
    expect((data?.availableAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it("separates a missing queue from a queue that refused", async () => {
    state.next = [row()];
    requireJobQueue.mockRejectedValue(new Error("not enabled"));

    await createOutboxDispatcher({ registry }).runOnce();

    expect(updates()[0]?.lastErrorCode).toBe(
      OUTBOX_ERROR_CODE.QUEUE_UNAVAILABLE,
    );
  });

  it("dead-letters once the attempt budget is spent", async () => {
    state.next = [row({ publishAttempts: 3 })];
    add.mockRejectedValue(new Error("still down"));

    const summary = await createOutboxDispatcher({ registry }).runOnce();

    expect(summary).toMatchObject({ deadLettered: 1 });
    expect(updates()[0]).toMatchObject({
      deadLetterCode: OUTBOX_DEAD_LETTER_CODE.PUBLISH_ATTEMPTS_EXHAUSTED,
      deadLetteredAt: expect.any(Date),
    });
  });

  it("never writes an exception message into the row", async () => {
    state.next = [row()];
    add.mockRejectedValue(
      new Error("redis://user:hunter2@queue.example:6380 refused"),
    );

    await createOutboxDispatcher({ registry }).runOnce();

    const written = JSON.stringify(updates());

    expect(written).not.toContain("hunter2");
    expect(written).not.toContain("queue.example");
  });
});

describe("poison messages", () => {
  it.each([
    {
      name: "an unknown job",
      row: row({ jobName: "nobody.knows" }),
      code: OUTBOX_DEAD_LETTER_CODE.UNKNOWN_JOB,
    },
    {
      name: "an unsupported version",
      row: row({ jobVersion: 9 }),
      code: OUTBOX_DEAD_LETTER_CODE.UNSUPPORTED_VERSION,
    },
    {
      name: "a payload that fails the schema",
      row: row({ payload: { userId: 7 } }),
      code: OUTBOX_DEAD_LETTER_CODE.INVALID_PAYLOAD,
    },
    {
      name: "an oversized payload",
      row: row({ payload: { userId: "x".repeat(MAX_JOB_PAYLOAD_BYTES) } }),
      code: OUTBOX_DEAD_LETTER_CODE.PAYLOAD_TOO_LARGE,
    },
  ])("dead-letters $name without publishing", async (testCase) => {
    state.next = [testCase.row];

    const summary = await createOutboxDispatcher({ registry }).runOnce();

    expect(summary).toMatchObject({ deadLettered: 1, published: 0 });
    expect(add).not.toHaveBeenCalled();
    expect(updates()[0]?.deadLetterCode).toBe(testCase.code);
    expect(events()).toContain(JOBS_LOG_EVENT.OUTBOX_DEAD_LETTERED);
  });

  it("leaves the row in place rather than deleting it", async () => {
    state.next = [row({ jobName: "nobody.knows" })];

    await createOutboxDispatcher({ registry }).runOnce();

    // "What happened to that message" must always have an answer.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deadLetteredAt: null }),
      }),
    );
  });
});

describe("the polling loop", () => {
  it("stops promptly rather than waiting out an interval", async () => {
    process.env.OUTBOX_POLL_INTERVAL_MS = "50000";
    process.env.OUTBOX_LEASE_MS = "60000";
    resetJobsConfiguration();

    const dispatcher = createOutboxDispatcher({ registry });

    dispatcher.start();
    expect(dispatcher.isRunning()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await dispatcher.stop();

    expect(dispatcher.isRunning()).toBe(false);

    delete process.env.OUTBOX_POLL_INTERVAL_MS;
    delete process.env.OUTBOX_LEASE_MS;
  });

  it("is safe to start twice and stop twice", async () => {
    const dispatcher = createOutboxDispatcher({ registry });

    dispatcher.start();
    dispatcher.start();

    await dispatcher.stop();
    await expect(dispatcher.stop()).resolves.toBeUndefined();
  });

  it("survives a database failure instead of dying", async () => {
    // A dispatcher that dies on a transient error stops publishing for
    // everyone.
    transaction.mockRejectedValueOnce(new Error("connection terminated"));

    const dispatcher = createOutboxDispatcher({ registry });

    dispatcher.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await dispatcher.stop();

    expect(events()).toContain(JOBS_LOG_EVENT.OUTBOX_PUBLISH_FAILED);
  });

  it("gives each dispatcher its own identity", () => {
    expect(createOutboxDispatcher({ registry }).id).not.toBe(
      createOutboxDispatcher({ registry }).id,
    );
    expect(createOutboxDispatcher({ registry, dispatcherId: "fixed" }).id).toBe(
      "fixed",
    );
  });
});
