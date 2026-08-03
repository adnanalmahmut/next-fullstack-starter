import { trace, type Tracer } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JOB_SPAN, withJobSpan } from "./tracing";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A span whose recorded calls can be inspected.
 *
 * `setAttributes`, `setAttribute`, `setStatus`, and `end` are all present, because
 * the shared tracing contract calls each of them and a missing method would be
 * swallowed by its guards — which would make an assertion pass for the wrong
 * reason.
 */
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

describe("with no SDK registered", () => {
  it("runs the operation and returns its value", () => {
    // The API package is a facade. With nothing registered every call is a
    // no-op, which is what lets a job be traced on a deployment that exports
    // nothing.
    return expect(
      withJobSpan(JOB_SPAN.EXECUTE, { jobName: "a.b" }, async () => "value"),
    ).resolves.toBe("value");
  });

  it("propagates a failure unchanged", async () => {
    const failure = new Error("handler failed");

    await expect(
      withJobSpan(JOB_SPAN.OUTBOX_PUBLISH, {}, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});

describe("tracing never fails a job", () => {
  it("runs the operation even when starting a span throws", async () => {
    vi.spyOn(trace, "getTracer").mockImplementation(() => {
      throw new Error("tracer is broken");
    });

    await expect(
      withJobSpan(JOB_SPAN.EXECUTE, {}, async () => "value"),
    ).resolves.toBe("value");
  });

  it("swallows a failure to end the span", async () => {
    const span = createSpanDouble();

    span.end.mockImplementation(() => {
      throw new Error("end is broken");
    });
    mockTracer(span);

    await expect(
      withJobSpan(JOB_SPAN.EXECUTE, {}, async () => "value"),
    ).resolves.toBe("value");
  });
});

describe("job span identity", () => {
  it("carries identity only, never a payload", async () => {
    const span = createSpanDouble();
    const startSpan = mockTracer(span);

    await withJobSpan(
      JOB_SPAN.EXECUTE,
      { jobName: "a.b", jobVersion: 1, outboxId: "o-1", attempt: 2 },
      async () => undefined,
    );

    expect(startSpan).toHaveBeenCalledWith(JOB_SPAN.EXECUTE, {
      attributes: {
        "jobs.jobName": "a.b",
        "jobs.jobVersion": 1,
        "jobs.outboxId": "o-1",
        "jobs.attempt": 2,
      },
    });
  });

  it("uses the two stable span names and nothing else", () => {
    expect(JOB_SPAN).toEqual({
      OUTBOX_PUBLISH: "jobs.outbox.publish",
      EXECUTE: "jobs.execute",
    });
  });

  it("marks a failed span with a status code and no message", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    await expect(
      withJobSpan(JOB_SPAN.EXECUTE, {}, async () => {
        throw new Error("connection to redis://127.0.0.1:6379 refused");
      }),
    ).rejects.toThrow();

    // A status message would be the error message, and an error message is the
    // usual way an address escapes into a trace.
    expect(span.setStatus).toHaveBeenCalledTimes(1);
    expect(Object.keys(span.setStatus.mock.calls[0]?.[0] ?? {})).toEqual([
      "code",
    ]);

    // The outcome is an attribute; the failure's message and stack are nowhere.
    const attributeCalls = span.setAttribute.mock.calls.map((call) => call[0]);

    expect(attributeCalls).toEqual(["app.outcome"]);
    expect(span.setAttribute).toHaveBeenCalledWith("app.outcome", "failed");
  });

  it("marks a successful span as succeeded", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    await withJobSpan(JOB_SPAN.OUTBOX_PUBLISH, {}, async () => "value");

    expect(span.setAttribute).toHaveBeenCalledWith("app.outcome", "succeeded");
    expect(span.end).toHaveBeenCalledTimes(1);
  });
});
