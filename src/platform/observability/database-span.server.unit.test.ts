import { trace, type Tracer } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConflictError } from "@/shared/errors/application-error";

import {
  DATABASE_OPERATION,
  DATABASE_OPERATIONS,
  withDatabaseOperationSpan,
} from "./database-span.server";

afterEach(() => {
  vi.restoreAllMocks();
});

function createSpanDouble() {
  return {
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
  };
}

function mockTracer(span: ReturnType<typeof createSpanDouble>) {
  const startSpan = vi.fn(() => span);

  vi.spyOn(trace, "getTracer").mockReturnValue({
    startSpan,
  } as unknown as Tracer);

  return startSpan;
}

describe("the operation registry", () => {
  it("names every operational database boundary and nothing else", () => {
    expect(DATABASE_OPERATIONS).toEqual([
      "audit.append",
      "audit.list",
      "outbox.write",
      "outbox.claim",
      "outbox.mark_published",
      "outbox.reschedule",
      "outbox.dead_letter",
      "outbox.backlog",
      "jobs.execution_receipt",
      "storage.upload_intent.create",
      "storage.finalize.claim",
      "storage.finalize.commit",
      "storage.cleanup.claim",
    ]);
  });

  it("names no table and no statement", () => {
    for (const operation of DATABASE_OPERATIONS) {
      expect(operation, operation).not.toMatch(
        /select|insert|update|delete|from|where/i,
      );
    }
  });
});

describe("with no SDK registered", () => {
  it("returns the operation's value", () =>
    expect(
      withDatabaseOperationSpan(
        DATABASE_OPERATION.AUDIT_APPEND,
        async () => "record-id",
      ),
    ).resolves.toBe("record-id"));

  it("propagates a database failure unchanged", async () => {
    const failure = new Error("duplicate key value violates unique constraint");

    await expect(
      withDatabaseOperationSpan(DATABASE_OPERATION.OUTBOX_WRITE, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});

describe("span content", () => {
  it("names the span after the operation and carries the operation name", async () => {
    const span = createSpanDouble();
    const startSpan = mockTracer(span);

    await withDatabaseOperationSpan(
      DATABASE_OPERATION.OUTBOX_CLAIM,
      async () => 3,
    );

    expect(startSpan).toHaveBeenCalledWith("db.outbox.claim", {
      attributes: { "db.operation.name": "outbox.claim" },
    });
    expect(span.setAttribute).toHaveBeenCalledWith("app.outcome", "succeeded");
  });

  it("attaches a stable code when the failure carries one", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    await expect(
      withDatabaseOperationSpan(
        DATABASE_OPERATION.STORAGE_FINALIZE_COMMIT,
        async () => {
          throw new ConflictError("the lease was taken");
        },
      ),
    ).rejects.toThrow();

    expect(span.setAttribute).toHaveBeenCalledWith("app.outcome", "failed");
    expect(span.setAttribute).toHaveBeenCalledWith(
      "app.error.code",
      "CONFLICT",
    );
  });

  it("attaches no code for a driver failure, and no SQL", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    await expect(
      withDatabaseOperationSpan(DATABASE_OPERATION.AUDIT_LIST, async () => {
        throw new Error(
          'relation "audit_record" does not exist at character 42',
        );
      }),
    ).rejects.toThrow();

    const attributeNames = span.setAttribute.mock.calls.map((call) => call[0]);

    // A driver message is the schema. `INTERNAL_ERROR` would say no more than the
    // outcome already does, so nothing beyond the outcome is attached.
    expect(attributeNames).toEqual(["app.outcome"]);
    expect(JSON.stringify(span.setAttribute.mock.calls)).not.toContain(
      "audit_record",
    );
  });
});

describe("failure containment", () => {
  it("runs the operation when the tracer throws", async () => {
    vi.spyOn(trace, "getTracer").mockImplementation(() => {
      throw new Error("tracer is broken");
    });

    await expect(
      withDatabaseOperationSpan(
        DATABASE_OPERATION.JOB_EXECUTION_RECEIPT,
        async () => "value",
      ),
    ).resolves.toBe("value");
  });

  it("runs the operation exactly once", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    const run = vi.fn(async () => "value");

    await withDatabaseOperationSpan(DATABASE_OPERATION.OUTBOX_WRITE, run);

    expect(run).toHaveBeenCalledTimes(1);
  });
});
