import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { activeTraceLogFields } from "./trace-log-fields";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockActiveSpan(spanContext: Record<string, unknown>): void {
  vi.spyOn(trace, "getActiveSpan").mockReturnValue({
    spanContext: () => spanContext,
  } as never);
}

describe("with no active span", () => {
  it("adds no fields at all", () => {
    // With no SDK registered the bindings are byte for byte what they were before
    // tracing existed, which is what keeps every existing log assertion valid.
    expect(activeTraceLogFields()).toEqual({});
  });
});

describe("with a valid active span", () => {
  it("borrows the three correlation identifiers", () => {
    mockActiveSpan({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
    });

    expect(activeTraceLogFields()).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    });
  });

  it("renders an unsampled trace's flags", () => {
    mockActiveSpan({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 0,
    });

    expect(activeTraceLogFields().traceFlags).toBe("00");
  });

  it("carries no propagation wire format and no baggage", () => {
    mockActiveSpan({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
      traceState: { serialize: () => "vendor=value" },
    });

    expect(Object.keys(activeTraceLogFields()).sort()).toEqual([
      "spanId",
      "traceFlags",
      "traceId",
    ]);
  });
});

describe("with an unusable span context", () => {
  it("adds no fields for an all-zero context", () => {
    mockActiveSpan({
      traceId: "00000000000000000000000000000000",
      spanId: "0000000000000000",
      traceFlags: 0,
    });

    expect(activeTraceLogFields()).toEqual({});
  });

  it("adds no fields when reading the span throws", () => {
    vi.spyOn(trace, "getActiveSpan").mockImplementation(() => {
      throw new Error("broken");
    });

    // Reading a span context must never be able to stop a line being logged.
    expect(activeTraceLogFields()).toEqual({});
  });
});
