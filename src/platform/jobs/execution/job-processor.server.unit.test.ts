import { UnrecoverableError, type Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { logJobEvent } = vi.hoisted(() => ({ logJobEvent: vi.fn() }));

vi.mock("../observability/job-logger.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logJobEvent,
}));

const { defineJob, JOB_BACKOFF_TYPE } =
  await import("../definitions/define-job");
const { createJobRegistry } = await import("../definitions/job-registry");
const { JOBS_LOG_EVENT } = await import("../observability/log-event");
const { jobExecutionKey } = await import("./execution-key");
const { JOB_FAILURE_CODE, PermanentJobError } = await import("./job-failure");
const { createJobProcessor } = await import("./job-processor.server");

/**
 * The class arrives through a dynamic import, so only its value is in scope; the
 * instance type has to be recovered from it.
 */
type PermanentJobFailure = InstanceType<typeof PermanentJobError>;

type HandlerArguments = {
  payload: { userId: string };
  signal: AbortSignal;
  context: Record<string, unknown>;
};

const handle = vi.fn<(args: HandlerArguments) => Promise<{ deleted: number }>>(
  async () => ({ deleted: 1 }),
);

function job(overrides: Partial<Parameters<typeof defineJob>[0]> = {}) {
  return defineJob({
    name: "identity.user-deleted",
    version: 1,
    payloadSchema: z.object({ userId: z.string().min(1) }).strict(),
    resultSchema: z.object({ deleted: z.number() }).strict(),
    attempts: 3,
    backoff: { type: JOB_BACKOFF_TYPE.EXPONENTIAL, delayMs: 1_000 },
    timeoutMs: 1_000,
    timeoutRetryable: true,
    idempotency: { key: (payload: { userId: string }) => payload.userId },
    handle,
    ...overrides,
  } as Parameters<typeof defineJob>[0]);
}

const envelope = {
  jobName: "identity.user-deleted",
  version: 1,
  payload: { userId: "u-1" },
  outboxId: "0193f0a1-0000-7000-8000-000000000000",
  correlationId: "0193f0a1-0000-7000-8000-000000000001",
  occurredAt: "2026-08-01T12:00:00.000Z",
};

function fakeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "0193f0a1-0000-7000-8000-000000000000",
    queueName: "jobs",
    attemptsMade: 0,
    data: envelope,
    ...overrides,
  } as Job;
}

function eventsLogged(): string[] {
  return logJobEvent.mock.calls.map((call) => String(call[1]));
}

beforeEach(() => {
  logJobEvent.mockClear();
  handle.mockClear();
  handle.mockResolvedValue({ deleted: 1 });
});

describe("a message is validated before anything else happens", () => {
  it("refuses an envelope that does not match, permanently", async () => {
    // Redis is not a trust boundary, and the row may have been written by an
    // older release.
    const runJob = createJobProcessor(createJobRegistry([job()]));

    await expect(
      runJob(fakeJob({ data: { jobName: "identity.user-deleted" } })),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(handle).not.toHaveBeenCalled();
  });

  it("refuses an unknown job", async () => {
    const runJob = createJobProcessor(createJobRegistry([]));
    const failure = (await runJob(fakeJob()).catch(
      (error: unknown) => error,
    )) as PermanentJobFailure;

    expect(failure.code).toBe(JOB_FAILURE_CODE.UNKNOWN_JOB);
  });

  it("separates an unsupported version from an unknown job", async () => {
    const runJob = createJobProcessor(createJobRegistry([job({ version: 2 })]));
    const failure = (await runJob(fakeJob()).catch(
      (error: unknown) => error,
    )) as PermanentJobFailure;

    expect(failure.code).toBe(JOB_FAILURE_CODE.UNSUPPORTED_VERSION);
  });

  it("validates the payload against the definition's own schema", async () => {
    const runJob = createJobProcessor(createJobRegistry([job()]));
    const failure = (await runJob(
      fakeJob({ data: { ...envelope, payload: { userId: "" } } }),
    ).catch((error: unknown) => error)) as PermanentJobFailure;

    expect(failure.code).toBe(JOB_FAILURE_CODE.INVALID_PAYLOAD);
    expect(handle).not.toHaveBeenCalled();
  });
});

describe("what the handler is given", () => {
  it("gets the validated payload, a signal, and identifiers only", async () => {
    const runJob = createJobProcessor(createJobRegistry([job()]));

    await runJob(fakeJob({ attemptsMade: 1 }));

    const args = handle.mock.calls[0]?.[0];

    expect(args?.payload).toEqual({ userId: "u-1" });
    expect(args?.signal).toBeInstanceOf(AbortSignal);
    expect(args?.context).toEqual({
      jobName: "identity.user-deleted",
      jobVersion: 1,
      jobId: "0193f0a1-0000-7000-8000-000000000000",
      outboxId: "0193f0a1-0000-7000-8000-000000000000",
      attempt: 2,
      maxAttempts: 3,
      correlationId: "0193f0a1-0000-7000-8000-000000000001",
      occurredAt: "2026-08-01T12:00:00.000Z",
      executionKey: jobExecutionKey("identity.user-deleted", 1, "u-1"),
    });
  });

  it("gets no queue, no connection, and no database client", async () => {
    const runJob = createJobProcessor(createJobRegistry([job()]));

    await runJob(fakeJob());

    const args = handle.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;

    expect(Object.keys(args).sort()).toEqual(["context", "payload", "signal"]);
  });

  it("counts the attempt it is running, not the ones already made", async () => {
    const runJob = createJobProcessor(createJobRegistry([job()]));

    await runJob(fakeJob({ attemptsMade: 0 }));

    expect(handle.mock.calls[0]?.[0].context.attempt).toBe(1);
  });
});

describe("the result", () => {
  it("is returned when it matches the schema", async () => {
    const runJob = createJobProcessor(createJobRegistry([job()]));

    await expect(runJob(fakeJob())).resolves.toEqual({ deleted: 1 });
  });

  it("fails permanently when it does not", async () => {
    // The effect has already happened, so retrying would replay it; failing
    // once keeps the defect visible.
    handle.mockResolvedValue({ deleted: "one" } as never);

    const runJob = createJobProcessor(createJobRegistry([job()]));

    await expect(runJob(fakeJob())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(eventsLogged()).toContain(JOBS_LOG_EVENT.JOB_DEAD_LETTERED);
  });
});

describe("failure handling", () => {
  it("lets a transient failure through so BullMQ retries it", async () => {
    const failure = new Error("connection reset");

    handle.mockRejectedValue(failure);

    const runJob = createJobProcessor(createJobRegistry([job()]));

    await expect(runJob(fakeJob())).rejects.toBe(failure);
    expect(eventsLogged()).toContain(JOBS_LOG_EVENT.JOB_RETRYING);
    expect(eventsLogged()).not.toContain(JOBS_LOG_EVENT.JOB_DEAD_LETTERED);
  });

  it("stops the retries for a permanent failure", async () => {
    handle.mockRejectedValue(
      new PermanentJobError(JOB_FAILURE_CODE.HANDLER_FAILED, "no"),
    );

    const runJob = createJobProcessor(createJobRegistry([job()]));

    await expect(runJob(fakeJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("records the exhausted budget as its own event", async () => {
    handle.mockRejectedValue(new Error("still failing"));

    const runJob = createJobProcessor(createJobRegistry([job()]));

    await expect(runJob(fakeJob({ attemptsMade: 2 }))).rejects.toThrow();

    const events = eventsLogged();

    expect(events).toContain(JOBS_LOG_EVENT.JOB_FAILED);
    expect(events).toContain(JOBS_LOG_EVENT.JOB_DEAD_LETTERED);
  });

  it("reports a timeout as a timeout", async () => {
    handle.mockImplementation(
      async ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const runJob = createJobProcessor(
      createJobRegistry([job({ timeoutMs: 100 })]),
    );

    await expect(runJob(fakeJob())).rejects.toThrow();
    expect(eventsLogged()).toContain(JOBS_LOG_EVENT.JOB_TIMED_OUT);
  });

  it("makes a non-retryable timeout permanent", async () => {
    handle.mockImplementation(
      async ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ deleted: 0 }));
        }),
    );

    const runJob = createJobProcessor(
      createJobRegistry([job({ timeoutMs: 100, timeoutRetryable: false })]),
    );

    await expect(runJob(fakeJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe("what is logged", () => {
  it("carries identity, counters, and a stable code only", async () => {
    handle.mockRejectedValue(
      new Error(
        "failed to reach redis://127.0.0.1:6379 for person@example.com",
      ),
    );

    const runJob = createJobProcessor(createJobRegistry([job()]));

    await expect(runJob(fakeJob())).rejects.toThrow();

    const logged = JSON.stringify(logJobEvent.mock.calls);

    expect(logged).not.toContain("127.0.0.1");
    expect(logged).not.toContain("person@example.com");
    expect(logged).not.toContain("u-1");
  });

  it("keeps the permanent failure message to the code", async () => {
    handle.mockRejectedValue(
      new PermanentJobError(
        JOB_FAILURE_CODE.HANDLER_FAILED,
        "user person@example.com is unknown",
      ),
    );

    const runJob = createJobProcessor(createJobRegistry([job()]));
    const failure = (await runJob(fakeJob()).catch(
      (error: unknown) => error,
    )) as Error;

    // BullMQ serializes a failed job's message into Redis, so it must not carry
    // the original text.
    expect(failure.message).toBe("Job failed permanently: handler-failed");
  });

  it("records a start and a success", async () => {
    const runJob = createJobProcessor(createJobRegistry([job()]));

    await runJob(fakeJob());

    expect(eventsLogged()).toEqual([
      JOBS_LOG_EVENT.JOB_STARTED,
      JOBS_LOG_EVENT.JOB_SUCCEEDED,
    ]);
  });
});
