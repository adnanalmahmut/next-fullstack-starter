import { context, trace, type Tracer } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { currentTraceContext, JOB_SPAN, withJobSpan } from "./tracing";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("with no SDK registered", () => {
  it("runs the operation and returns its value", () => {
    // The API package is a facade. With nothing registered every call is a
    // no-op, which is what lets this project depend on it without choosing a
    // vendor for a downstream project.
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

  it("reports no trace context", () => {
    expect(currentTraceContext()).toBeUndefined();
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

  it("runs the operation even when activating the span throws", async () => {
    const span = {
      setStatus: vi.fn(),
      end: vi.fn(),
    };

    vi.spyOn(trace, "getTracer").mockReturnValue({
      startSpan: () => span,
    } as unknown as Tracer);
    vi.spyOn(context, "with").mockImplementation(() => {
      throw new Error("context is broken");
    });

    await expect(
      withJobSpan(JOB_SPAN.EXECUTE, {}, async () => "value"),
    ).resolves.toBe("value");
    expect(span.end).toHaveBeenCalled();
  });

  it("swallows a failure to end the span", async () => {
    vi.spyOn(trace, "getTracer").mockReturnValue({
      startSpan: () => ({
        setStatus: vi.fn(),
        end: () => {
          throw new Error("end is broken");
        },
      }),
    } as unknown as Tracer);

    await expect(
      withJobSpan(JOB_SPAN.EXECUTE, {}, async () => "value"),
    ).resolves.toBe("value");
  });

  it("answers undefined when reading the active span throws", () => {
    vi.spyOn(trace, "getActiveSpan").mockImplementation(() => {
      throw new Error("broken");
    });

    expect(currentTraceContext()).toBeUndefined();
  });
});

describe("span attributes", () => {
  it("carry identity only, never a payload", async () => {
    const startSpan = vi.fn(() => ({ setStatus: vi.fn(), end: vi.fn() }));

    vi.spyOn(trace, "getTracer").mockReturnValue({
      startSpan,
    } as unknown as Tracer);

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

  it("marks a failed span with a status code and no message", async () => {
    const setStatus = vi.fn();

    vi.spyOn(trace, "getTracer").mockReturnValue({
      startSpan: () => ({ setStatus, end: vi.fn() }),
    } as unknown as Tracer);

    await expect(
      withJobSpan(JOB_SPAN.EXECUTE, {}, async () => {
        throw new Error("connection to redis://127.0.0.1:6379 refused");
      }),
    ).rejects.toThrow();

    // A status message would be the error message, and an error message is the
    // usual way an address escapes into a trace.
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(Object.keys(setStatus.mock.calls[0]?.[0] ?? {})).toEqual(["code"]);
  });
});

describe("reading the caller's trace context", () => {
  it("formats a valid span context as a W3C traceparent", () => {
    vi.spyOn(trace, "getActiveSpan").mockReturnValue({
      spanContext: () => ({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: 1,
      }),
    } as never);

    expect(currentTraceContext()).toEqual({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
  });

  it("ignores an invalid span context", () => {
    vi.spyOn(trace, "getActiveSpan").mockReturnValue({
      spanContext: () => ({
        traceId: "00000000000000000000000000000000",
        spanId: "0000000000000000",
        traceFlags: 0,
      }),
    } as never);

    expect(currentTraceContext()).toBeUndefined();
  });
});
