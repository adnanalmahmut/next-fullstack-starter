import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  defineJob,
  JOB_BACKOFF_TYPE,
  MAX_JOB_ATTEMPTS,
  MAX_JOB_TIMEOUT_MS,
  MIN_JOB_BACKOFF_DELAY_MS,
  type JobDefinitionInput,
} from "./define-job";
import { MAX_JOB_PAYLOAD_BYTES } from "./job-envelope";

const payloadSchema = z.object({ userId: z.string().min(1) }).strict();

function input(
  overrides: Partial<JobDefinitionInput<{ userId: string }, void>> = {},
): JobDefinitionInput<{ userId: string }, void> {
  return {
    name: "identity.user-deleted",
    version: 1,
    payloadSchema,
    attempts: 3,
    backoff: { type: JOB_BACKOFF_TYPE.EXPONENTIAL, delayMs: 1_000 },
    timeoutMs: 10_000,
    timeoutRetryable: true,
    idempotency: { key: (payload) => payload.userId },
    handle: async () => undefined,
    ...overrides,
  };
}

describe("a definition is validated where it is written", () => {
  it("accepts a well-formed declaration", () => {
    const job = defineJob(input());

    expect(job.identity).toBe("identity.user-deleted.v1");
    expect(job.runtime.identity).toBe(job.identity);
  });

  it.each([
    ["a bare name", { name: "cleanup" }, /job name/],
    ["a zero version", { version: 0 }, /job version/],
    ["no attempts", { attempts: 0 }, /attempts/],
    ["too many attempts", { attempts: MAX_JOB_ATTEMPTS + 1 }, /attempts/],
    [
      "a backoff below the floor",
      { backoff: { type: JOB_BACKOFF_TYPE.FIXED, delayMs: 1 } },
      /backoff delay/,
    ],
    [
      "an unknown backoff type",
      {
        backoff: {
          type: "linear" as unknown as typeof JOB_BACKOFF_TYPE.FIXED,
          delayMs: 1_000,
        },
      },
      /backoff type/,
    ],
    [
      "a timeout above the ceiling",
      { timeoutMs: MAX_JOB_TIMEOUT_MS + 1 },
      /timeout/,
    ],
    ["a fractional timeout", { timeoutMs: 1_000.5 }, /timeout/],
  ])("refuses %s", (_name, overrides, message) => {
    expect(() =>
      defineJob(
        input(
          overrides as Partial<JobDefinitionInput<{ userId: string }, void>>,
        ),
      ),
    ).toThrow(message);
  });

  it("refuses a definition with no idempotency derivation", () => {
    expect(() =>
      defineJob(
        input({
          idempotency: {
            key: undefined as unknown as (payload: {
              userId: string;
            }) => string,
          },
        }),
      ),
    ).toThrow(/idempotency/);
  });

  it("accepts the minimum backoff", () => {
    expect(() =>
      defineJob(
        input({
          backoff: {
            type: JOB_BACKOFF_TYPE.FIXED,
            delayMs: MIN_JOB_BACKOFF_DELAY_MS,
          },
        }),
      ),
    ).not.toThrow();
  });
});

describe("the type-erased runtime view", () => {
  it("parses a payload through the definition's own schema", () => {
    const job = defineJob(input());

    expect(job.runtime.parsePayload({ userId: "u-1" })).toEqual({
      ok: true,
      payload: { userId: "u-1" },
    });
    expect(job.runtime.parsePayload({ userId: "" }).ok).toBe(false);
    expect(job.runtime.parsePayload({ user: "u-1" }).ok).toBe(false);
  });

  it("refuses an oversized payload before it reaches the schema", () => {
    const schema = z.object({ note: z.string() }).strict();
    const job = defineJob({
      ...input(),
      payloadSchema: schema as unknown as z.ZodType<{ userId: string }>,
    });

    expect(
      job.runtime.parsePayload({ note: "x".repeat(MAX_JOB_PAYLOAD_BYTES) }).ok,
    ).toBe(false);
  });

  it("passes a result through when no result schema is declared", () => {
    const job = defineJob(input());

    expect(job.runtime.parseResult(undefined)).toEqual({
      ok: true,
      result: undefined,
    });
    expect(job.runtime.parseResult({ any: "thing" })).toEqual({
      ok: true,
      result: { any: "thing" },
    });
  });

  it("validates a result against the declared schema", () => {
    const job = defineJob({
      ...input(),
      resultSchema: z.object({ deleted: z.number() }).strict(),
      handle: async () => ({ deleted: 1 }),
    });

    expect(job.runtime.parseResult({ deleted: 1 }).ok).toBe(true);
    expect(job.runtime.parseResult({ deleted: "1" }).ok).toBe(false);
  });

  it("refuses a result that cannot cross the boundary", () => {
    const job = defineJob(input());

    // BullMQ stores a return value in Redis as JSON. A `Date` would come back
    // as a string and a `Map` as `{}`.
    expect(job.runtime.parseResult(new Date()).ok).toBe(false);
    expect(job.runtime.parseResult(new Map()).ok).toBe(false);
  });

  it("derives the idempotency key from the payload", () => {
    const job = defineJob(input());

    expect(job.runtime.idempotencyKey({ userId: "u-9" })).toBe("u-9");
  });

  it("runs the declared handler with the payload, the signal, and the context", async () => {
    const handle = vi.fn(async () => undefined);
    const job = defineJob(input({ handle }));
    const signal = AbortSignal.abort();
    const context = {
      jobName: "identity.user-deleted",
      jobVersion: 1,
      jobId: "j-1",
      outboxId: "o-1",
      attempt: 1,
      maxAttempts: 3,
      correlationId: "c-1",
      occurredAt: "2026-08-01T12:00:00.000Z",
      executionKey: "k",
    };

    await job.runtime.run({ payload: { userId: "u-1" }, signal, context });

    expect(handle).toHaveBeenCalledWith({
      payload: { userId: "u-1" },
      signal,
      context,
    });
  });

  it("omits an absent result schema rather than storing undefined", () => {
    expect("resultSchema" in defineJob(input())).toBe(false);
  });
});
