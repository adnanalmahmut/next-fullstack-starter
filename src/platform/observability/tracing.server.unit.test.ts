import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  context as otelContext,
  propagation,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  currentTraceContext,
  runWithRemoteTraceContext,
  setSpanOutcomeSafely,
  SPAN_OUTCOME,
  withActiveSpan,
} from "./tracing.server";

const VALID_TRACEPARENT =
  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

/**
 * Registers the two pieces propagation needs, and nothing else.
 *
 * A propagator alone is not enough: with no context manager the API's no-op one
 * never makes a span active, so `inject` has nothing to read and `extract` has
 * nowhere to put what it read. Registering both here — and only here — keeps the
 * rest of the suite running against the genuine no-SDK default.
 */
function registerPropagation(): void {
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  otelContext.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  propagation.disable();
  otelContext.disable();
});

function createSpanDouble() {
  return {
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
    spanContext: () => ({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
    }),
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
  it("runs the operation and returns its value", () =>
    expect(
      withActiveSpan(
        "operation",
        { "app.operation.name": "x" },
        async () => "value",
      ),
    ).resolves.toBe("value"));

  it("propagates a failure unchanged", async () => {
    const failure = new Error("business failure");

    await expect(
      withActiveSpan("operation", {}, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("reports no trace context", () => {
    expect(currentTraceContext()).toBeUndefined();
  });

  it("accepts an outcome report without a span", () => {
    expect(() =>
      setSpanOutcomeSafely(SPAN_OUTCOME.FAILED, "CODE"),
    ).not.toThrow();
  });
});

describe("failure containment", () => {
  it("runs the operation when the tracer throws", async () => {
    vi.spyOn(trace, "getTracer").mockImplementation(() => {
      throw new Error("tracer is broken");
    });

    await expect(
      withActiveSpan("operation", {}, async () => "value"),
    ).resolves.toBe("value");
  });

  it("runs the operation exactly once when context activation throws", async () => {
    const span = createSpanDouble();

    mockTracer(span);
    vi.spyOn(otelContext, "with").mockImplementation(() => {
      throw new Error("context is broken");
    });

    const run = vi.fn(async () => "value");

    await expect(withActiveSpan("operation", {}, run)).resolves.toBe("value");
    // The recovery path is only taken because the operation provably had not
    // started. Running it twice would repeat a mutation.
    expect(run).toHaveBeenCalledTimes(1);
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("does not re-run an operation that threw inside the context", async () => {
    const span = createSpanDouble();
    const failure = new Error("business failure");

    mockTracer(span);

    const run = vi.fn(async () => {
      throw failure;
    });

    await expect(withActiveSpan("operation", {}, run)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("swallows a failure to set attributes", async () => {
    const span = createSpanDouble();

    span.setAttributes.mockImplementation(() => {
      throw new Error("attributes are broken");
    });
    mockTracer(span);

    await expect(
      withActiveSpan("operation", {}, async (recorder) => {
        recorder.setAttributes({ "app.operation.name": "x" });

        return "value";
      }),
    ).resolves.toBe("value");
  });

  it("swallows a failure to set the status", async () => {
    const span = createSpanDouble();

    span.setStatus.mockImplementation(() => {
      throw new Error("status is broken");
    });
    mockTracer(span);

    await expect(
      withActiveSpan("operation", {}, async (recorder) => {
        recorder.setOutcome(SPAN_OUTCOME.SUCCEEDED);

        return "value";
      }),
    ).resolves.toBe("value");
  });

  it("swallows a failure to end the span", async () => {
    const span = createSpanDouble();

    span.end.mockImplementation(() => {
      throw new Error("end is broken");
    });
    mockTracer(span);

    await expect(
      withActiveSpan("operation", {}, async () => "value"),
    ).resolves.toBe("value");
  });

  it("answers undefined when reading the active span throws", () => {
    vi.spyOn(trace, "getActiveSpan").mockImplementation(() => {
      throw new Error("broken");
    });

    expect(currentTraceContext()).toBeUndefined();
  });
});

describe("span outcomes", () => {
  it("records a success as an outcome attribute and an OK status", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    await withActiveSpan("operation", {}, async (recorder) => {
      recorder.setOutcome(SPAN_OUTCOME.SUCCEEDED);
    });

    expect(span.setAttribute).toHaveBeenCalledWith("app.outcome", "succeeded");
    expect(span.setStatus).toHaveBeenCalledWith({ code: 1 });
  });

  it("records a failure as a stable code and never a message", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    await withActiveSpan("operation", {}, async (recorder) => {
      recorder.setOutcome(SPAN_OUTCOME.FAILED, "VALIDATION_FAILED");
    });

    expect(span.setAttribute).toHaveBeenCalledWith("app.outcome", "failed");
    expect(span.setAttribute).toHaveBeenCalledWith(
      "app.error.code",
      "VALIDATION_FAILED",
    );
    expect(span.setStatus).toHaveBeenCalledWith({ code: 2 });
    expect(Object.keys(span.setStatus.mock.calls[0]?.[0] ?? {})).toEqual([
      "code",
    ]);
  });

  it("never records an exception on the span", async () => {
    const span = createSpanDouble() as Record<string, unknown>;
    const recordException = vi.fn();

    span.recordException = recordException;
    mockTracer(span as unknown as ReturnType<typeof createSpanDouble>);

    await expect(
      withActiveSpan("operation", {}, async () => {
        throw new Error("secret-payload-value");
      }),
    ).rejects.toThrow();

    // `recordException` copies the message and the stack onto the span, which is
    // the single most reliable way for a payload to reach a third party.
    expect(recordException).not.toHaveBeenCalled();
  });
});

describe("trace context propagation", () => {
  it("produces a W3C carrier from the active context", async () => {
    const span = createSpanDouble();

    mockTracer(span);
    registerPropagation();

    // The propagator reads the active context, so the span has to be genuinely
    // active rather than merely created.
    const carrier = await otelContext.with(
      trace.setSpan(
        otelContext.active(),
        span as unknown as Parameters<typeof trace.setSpan>[1],
      ),
      async () => currentTraceContext(),
    );

    expect(carrier).toEqual({ traceparent: VALID_TRACEPARENT });
  });

  it("carries no baggage", async () => {
    const span = createSpanDouble();

    mockTracer(span);
    registerPropagation();

    const carrier = await otelContext.with(
      trace.setSpan(
        otelContext.active(),
        span as unknown as Parameters<typeof trace.setSpan>[1],
      ),
      async () => currentTraceContext(),
    );

    expect(Object.keys(carrier ?? {})).toEqual(["traceparent"]);
  });

  it("restores a remote parent and runs the operation once", async () => {
    registerPropagation();

    const observed = await runWithRemoteTraceContext(
      { traceparent: VALID_TRACEPARENT },
      async () =>
        trace.getSpanContext(otelContext.active())?.traceId ?? "no-parent",
    );

    expect(observed).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("drops invalid context and runs as a root", async () => {
    registerPropagation();

    const run = vi.fn(
      async () => trace.getSpanContext(otelContext.active())?.traceId,
    );

    await expect(
      runWithRemoteTraceContext({ traceparent: "not-a-traceparent" }, run),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs as a root when no context is stored at all", async () => {
    const run = vi.fn(async () => "value");

    await expect(runWithRemoteTraceContext(undefined, run)).resolves.toBe(
      "value",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs the operation once when context activation throws", async () => {
    registerPropagation();
    vi.spyOn(otelContext, "with").mockImplementation(() => {
      throw new Error("context is broken");
    });

    const run = vi.fn(async () => "value");

    await expect(
      runWithRemoteTraceContext({ traceparent: VALID_TRACEPARENT }, run),
    ).resolves.toBe("value");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
