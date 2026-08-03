import { metrics, trace, type Meter, type Tracer } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetTelemetryInstruments } from "@/platform/observability/metrics.server";
import { ERROR_CODE } from "@/shared/errors/error-code";

import {
  ACTION_OPERATION_TYPE,
  ACTION_SPAN_ATTRIBUTE,
  withActionTelemetry,
} from "./action-telemetry.server";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  vi.restoreAllMocks();
  resetTelemetryInstruments();
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

function mockMeter() {
  const adds: { name: string; attributes: unknown }[] = [];
  const records: { name: string; value: number; attributes: unknown }[] = [];

  vi.spyOn(metrics, "getMeter").mockReturnValue({
    createCounter: (name: string) => ({
      add: (_value: number, attributes?: unknown) => {
        adds.push({ name, attributes });
      },
    }),
    createHistogram: (name: string) => ({
      record: (value: number, attributes?: unknown) => {
        records.push({ name, value, attributes });
      },
    }),
  } as unknown as Meter);

  resetTelemetryInstruments();

  return { adds, records };
}

describe("the action span", () => {
  it("is named from the action name", async () => {
    const span = createSpanDouble();
    const startSpan = mockTracer(span);

    await withActionTelemetry(
      "identity.user.rename",
      REQUEST_ID,
      async (telemetry) => {
        telemetry.report("succeeded");
      },
    );

    expect(startSpan).toHaveBeenCalledWith(
      `${ACTION_OPERATION_TYPE}.identity.user.rename`,
      {
        attributes: {
          [ACTION_SPAN_ATTRIBUTE.OPERATION_NAME]: "identity.user.rename",
          [ACTION_SPAN_ATTRIBUTE.OPERATION_TYPE]: ACTION_OPERATION_TYPE,
        },
      },
    );
  });

  it("carries the outcome and a stable code, never a message", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    await withActionTelemetry(
      "identity.user.rename",
      REQUEST_ID,
      async (telemetry) => {
        telemetry.report("failed", ERROR_CODE.VALIDATION_FAILED);
      },
    );

    expect(span.setAttribute).toHaveBeenCalledWith("app.outcome", "failed");
    expect(span.setAttribute).toHaveBeenCalledWith(
      "app.error.code",
      "VALIDATION_FAILED",
    );
    expect(Object.keys(span.setStatus.mock.calls[0]?.[0] ?? {})).toEqual([
      "code",
    ]);
  });

  it("carries no input, output, or actor", async () => {
    const span = createSpanDouble();
    const startSpan = mockTracer(span);

    await withActionTelemetry(
      "identity.user.rename",
      REQUEST_ID,
      async (telemetry) => {
        telemetry.report("succeeded");

        return { ok: true, data: { email: "person@example.com" } };
      },
    );

    const serialized = JSON.stringify([
      startSpan.mock.calls,
      span.setAttribute.mock.calls,
      span.setAttributes.mock.calls,
    ]);

    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain(REQUEST_ID);
  });
});

describe("the action metrics", () => {
  it("records the counter and the histogram exactly once", async () => {
    const meter = mockMeter();

    await withActionTelemetry(
      "identity.user.rename",
      REQUEST_ID,
      async (telemetry) => {
        telemetry.report("succeeded");
      },
    );

    expect(meter.adds).toHaveLength(1);
    expect(meter.records).toHaveLength(1);
    expect(meter.adds[0]?.attributes).toEqual({
      "action.name": "identity.user.rename",
      outcome: "succeeded",
    });
  });

  it("adds the error code to the count on failure", async () => {
    const meter = mockMeter();

    await withActionTelemetry(
      "identity.user.rename",
      REQUEST_ID,
      async (telemetry) => {
        telemetry.report("failed", ERROR_CODE.FORBIDDEN);
      },
    );

    expect(meter.adds[0]?.attributes).toEqual({
      "action.name": "identity.user.rename",
      outcome: "failed",
      error_code: "FORBIDDEN",
    });
    expect(meter.records[0]?.attributes).toEqual({
      "action.name": "identity.user.rename",
      outcome: "failed",
    });
  });

  it("records a failure when the body never reported", async () => {
    const meter = mockMeter();

    await withActionTelemetry(
      "identity.user.rename",
      undefined,
      async () => undefined,
    );

    expect(meter.adds[0]?.attributes).toEqual(
      expect.objectContaining({ outcome: "failed" }),
    );
  });
});

describe("failure containment", () => {
  it("returns the body's result when the tracer throws", async () => {
    vi.spyOn(trace, "getTracer").mockImplementation(() => {
      throw new Error("tracer is broken");
    });

    await expect(
      withActionTelemetry("identity.user.rename", REQUEST_ID, async (t) => {
        t.report("succeeded");

        return { ok: true } as const;
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("returns the body's result when the meter throws", async () => {
    vi.spyOn(metrics, "getMeter").mockImplementation(() => {
      throw new Error("meter is broken");
    });
    resetTelemetryInstruments();

    await expect(
      withActionTelemetry("identity.user.rename", REQUEST_ID, async (t) => {
        t.report("succeeded");

        return { ok: true } as const;
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("runs the body exactly once", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    const run = vi.fn(async () => ({ ok: true }) as const);

    await withActionTelemetry("identity.user.rename", REQUEST_ID, run);

    expect(run).toHaveBeenCalledTimes(1);
  });
});
