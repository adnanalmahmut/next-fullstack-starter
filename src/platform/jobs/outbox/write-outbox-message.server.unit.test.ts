import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { runWithRequestContext } from "@/platform/observability/request-context.server";
import {
  DependencyUnavailableError,
  ValidationError,
} from "@/shared/errors/application-error";

import { resetJobsConfiguration } from "../config/jobs-config";
import { defineJob, JOB_BACKOFF_TYPE } from "../definitions/define-job";
import { MAX_JOB_PAYLOAD_BYTES } from "../definitions/job-envelope";

import { writeOutboxMessage } from "./write-outbox-message.server";

const job = defineJob({
  name: "identity.user-deleted",
  version: 3,
  payloadSchema: z
    .object({ userId: z.string().min(1), reason: z.string().default("manual") })
    .strict(),
  attempts: 3,
  backoff: { type: JOB_BACKOFF_TYPE.EXPONENTIAL, delayMs: 1_000 },
  timeoutMs: 5_000,
  timeoutRetryable: true,
  idempotency: { key: (payload) => payload.userId },
  handle: async () => undefined,
});

type CreateArguments = { data: Record<string, unknown> };

function transaction() {
  const create = vi.fn(async () => ({ id: "generated" }));

  return {
    create,
    client: {
      outboxMessage: { create },
    } as unknown as Prisma.TransactionClient,
    lastData: () =>
      ((create.mock.calls as unknown[][]).at(-1)?.[0] as CreateArguments).data,
  };
}

const REQUEST_ID = "0193f0a1-0000-7000-8000-000000000001";

beforeEach(() => {
  process.env.JOBS_ENABLED = "true";
  resetJobsConfiguration();
});

afterEach(() => {
  delete process.env.JOBS_ENABLED;
  resetJobsConfiguration();
  vi.restoreAllMocks();
});

describe("recording work needs the flag and nothing else", () => {
  it("refuses when jobs are disabled", async () => {
    process.env.JOBS_ENABLED = "false";
    resetJobsConfiguration();

    const tx = transaction();

    await expect(
      writeOutboxMessage(tx.client, { job, payload: { userId: "u-1" } }),
    ).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(tx.create).not.toHaveBeenCalled();
  });

  it("writes with no queue address configured at all", async () => {
    // The web application must keep recording work while Redis and the worker
    // are down. That only holds if the write never asks where the queue is.
    const tx = transaction();

    delete process.env.JOBS_REDIS_URL;

    await expect(
      writeOutboxMessage(tx.client, { job, payload: { userId: "u-1" } }),
    ).resolves.toEqual({ outboxId: expect.any(String) });
  });
});

describe("the transaction client", () => {
  it("refuses the Prisma singleton at runtime, not only in the type", async () => {
    // A `PrismaClient` satisfies enough of `TransactionClient` to be passed by
    // a caller in a hurry, and it would work right up until a rollback failed
    // to remove the row.
    const singleton = {
      $transaction: async () => undefined,
      $connect: async () => undefined,
      outboxMessage: { create: vi.fn() },
    } as unknown as Prisma.TransactionClient;

    await expect(
      writeOutboxMessage(singleton, { job, payload: { userId: "u-1" } }),
    ).rejects.toThrow(/interactive transaction client/);
  });

  it("accepts the real transaction client, which still exposes $transaction", async () => {
    // Prisma's interactive client keeps `$transaction`, so that is not the
    // discriminator it looks like; connection management is.
    const tx = transaction();
    const interactive = {
      ...tx.client,
      $transaction: async () => undefined,
    } as unknown as Prisma.TransactionClient;

    await expect(
      writeOutboxMessage(interactive, { job, payload: { userId: "u-1" } }),
    ).resolves.toMatchObject({ outboxId: expect.any(String) });
  });

  it("opens no connection and calls no queue", async () => {
    const tx = transaction();

    await writeOutboxMessage(tx.client, { job, payload: { userId: "u-1" } });

    // The only thing it touched is the transaction it was handed.
    expect(tx.create).toHaveBeenCalledTimes(1);
  });
});

describe("the payload", () => {
  it("is validated against the job's own schema", async () => {
    const tx = transaction();

    await expect(
      writeOutboxMessage(tx.client, {
        job,
        payload: { userId: "" } as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(tx.create).not.toHaveBeenCalled();
  });

  it("is stored as the schema produced it, defaults included", async () => {
    const tx = transaction();

    await writeOutboxMessage(tx.client, { job, payload: { userId: "u-1" } });

    expect(tx.lastData().payload).toEqual({ userId: "u-1", reason: "manual" });
  });

  it("refuses a value that cannot survive JSON", async () => {
    const tx = transaction();

    await expect(
      writeOutboxMessage(tx.client, {
        job,
        payload: { userId: "u-1", reason: new Date() as never },
      }),
    ).rejects.toThrow(/JSON serializable/);
  });

  it("refuses an oversized value", async () => {
    const tx = transaction();

    await expect(
      writeOutboxMessage(tx.client, {
        job,
        payload: { userId: "x".repeat(MAX_JOB_PAYLOAD_BYTES) },
      }),
    ).rejects.toThrow(/transport limit/);
  });
});

describe("the identifiers", () => {
  it("generates the outbox id before the insert and returns it", async () => {
    const tx = transaction();
    const { outboxId } = await writeOutboxMessage(tx.client, {
      job,
      payload: { userId: "u-1" },
    });

    // The caller holds the identifier the moment the write is issued, so it can
    // carry it into its own response and into a causation chain.
    expect(tx.lastData().id).toBe(outboxId);
    expect(outboxId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("takes the correlation identifier from the ambient request", async () => {
    const tx = transaction();

    await runWithRequestContext({ requestId: REQUEST_ID }, async () => {
      await writeOutboxMessage(tx.client, { job, payload: { userId: "u-1" } });
    });

    expect(tx.lastData().correlationId).toBe(REQUEST_ID);
  });

  it("generates one when there is no request", async () => {
    const tx = transaction();

    await writeOutboxMessage(tx.client, { job, payload: { userId: "u-1" } });

    expect(tx.lastData().correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("prefers an explicit correlation identifier", async () => {
    const tx = transaction();

    await runWithRequestContext({ requestId: REQUEST_ID }, async () => {
      await writeOutboxMessage(tx.client, {
        job,
        payload: { userId: "u-1" },
        correlationId: "explicit-1",
      });
    });

    expect(tx.lastData().correlationId).toBe("explicit-1");
  });

  it("refuses an unacceptable identifier", async () => {
    const tx = transaction();

    await expect(
      writeOutboxMessage(tx.client, {
        job,
        payload: { userId: "u-1" },
        correlationId: "has spaces",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      writeOutboxMessage(tx.client, {
        job,
        payload: { userId: "u-1" },
        causationId: "has spaces",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("omits an absent causation rather than writing null", async () => {
    const tx = transaction();

    await writeOutboxMessage(tx.client, { job, payload: { userId: "u-1" } });

    expect("causationId" in tx.lastData()).toBe(false);
  });
});

describe("the trace context", () => {
  it("stores a valid pair", async () => {
    const tx = transaction();

    await writeOutboxMessage(tx.client, {
      job,
      payload: { userId: "u-1" },
      traceContext: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=abc",
      },
    });

    expect(tx.lastData().traceparent).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
    expect(tx.lastData().tracestate).toBe("vendor=abc");
  });

  it("drops a malformed one rather than refusing the write", async () => {
    // Observability is an aid; refusing to record work because a header was
    // mangled upstream would make it a correctness dependency.
    const tx = transaction();

    await writeOutboxMessage(tx.client, {
      job,
      payload: { userId: "u-1" },
      traceContext: { traceparent: "not-a-traceparent" },
    });

    expect("traceparent" in tx.lastData()).toBe(false);
  });
});

describe("what is written", () => {
  it("carries the job identity and nothing about the caller", async () => {
    const tx = transaction();

    await writeOutboxMessage(tx.client, {
      job,
      payload: { userId: "u-1" },
      availableAt: new Date("2026-08-02T00:00:00.000Z"),
    });

    const data = tx.lastData();

    expect(data.jobName).toBe("identity.user-deleted");
    expect(data.jobVersion).toBe(3);
    expect(data.availableAt).toEqual(new Date("2026-08-02T00:00:00.000Z"));
    expect(Object.keys(data).sort()).toEqual([
      "availableAt",
      "correlationId",
      "id",
      "jobName",
      "jobVersion",
      "payload",
    ]);
  });
});
