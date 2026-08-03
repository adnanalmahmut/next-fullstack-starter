import { metrics, trace, type Meter, type Tracer } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetTelemetryInstruments } from "@/platform/observability/metrics.server";
import { ERROR_CODE } from "@/shared/errors/error-code";

import {
  ROUTE_OPERATION_TYPE,
  ROUTE_SPAN_ATTRIBUTE,
  withRouteTelemetry,
} from "./route-telemetry.server";

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

describe("the route span", () => {
  it("is named from the route name, never from a URL", async () => {
    const span = createSpanDouble();
    const startSpan = mockTracer(span);

    await withRouteTelemetry(
      { routeName: "identity.user.role.set", method: "PATCH" },
      REQUEST_ID,
      async (telemetry) => {
        telemetry.report("succeeded", 200);
      },
    );

    expect(startSpan).toHaveBeenCalledWith(
      `${ROUTE_OPERATION_TYPE}.identity.user.role.set`,
      {
        attributes: {
          [ROUTE_SPAN_ATTRIBUTE.OPERATION_NAME]: "identity.user.role.set",
          [ROUTE_SPAN_ATTRIBUTE.OPERATION_TYPE]: ROUTE_OPERATION_TYPE,
          [ROUTE_SPAN_ATTRIBUTE.REQUEST_METHOD]: "PATCH",
        },
      },
    );
  });

  it("carries the response status and the outcome", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    await withRouteTelemetry(
      { routeName: "identity.user.list", method: "GET" },
      REQUEST_ID,
      async (telemetry) => {
        telemetry.report("succeeded", 200);
      },
    );

    expect(span.setAttributes).toHaveBeenCalledWith({
      [ROUTE_SPAN_ATTRIBUTE.RESPONSE_STATUS_CODE]: 200,
    });
    expect(span.setAttribute).toHaveBeenCalledWith("app.outcome", "succeeded");
  });

  it("carries a stable error code on failure and no message", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    await withRouteTelemetry(
      { routeName: "identity.user.list", method: "GET" },
      REQUEST_ID,
      async (telemetry) => {
        telemetry.report("failed", 403, ERROR_CODE.FORBIDDEN);
      },
    );

    expect(span.setAttribute).toHaveBeenCalledWith("app.outcome", "failed");
    expect(span.setAttribute).toHaveBeenCalledWith(
      "app.error.code",
      "FORBIDDEN",
    );
    expect(Object.keys(span.setStatus.mock.calls[0]?.[0] ?? {})).toEqual([
      "code",
    ]);
  });

  it("records a replay as its own outcome", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    await withRouteTelemetry(
      { routeName: "billing.charge.create", method: "POST" },
      REQUEST_ID,
      async (telemetry) => {
        telemetry.report("replayed", 201);
      },
    );

    // Collapsing a replay into `succeeded` would make a duplicate-submission rate
    // impossible to see.
    expect(span.setAttribute).toHaveBeenCalledWith("app.outcome", "replayed");
  });
});

describe("the route metrics", () => {
  it("records the counter and the histogram exactly once", async () => {
    const meter = mockMeter();

    await withRouteTelemetry(
      { routeName: "identity.user.list", method: "GET" },
      REQUEST_ID,
      async (telemetry) => {
        // A body may correct itself; only the last report counts, and only one
        // measurement is recorded.
        telemetry.report("failed", 500, ERROR_CODE.INTERNAL_ERROR);
        telemetry.report("succeeded", 200);
      },
    );

    expect(meter.adds).toHaveLength(1);
    expect(meter.records).toHaveLength(1);
    expect(meter.adds[0]?.attributes).toEqual({
      "route.name": "identity.user.list",
      "http.request.method": "GET",
      "http.response.status_code": 200,
      outcome: "succeeded",
    });
  });

  it("never carries the request id as a dimension", async () => {
    const meter = mockMeter();

    await withRouteTelemetry(
      { routeName: "identity.user.list", method: "GET" },
      REQUEST_ID,
      async (telemetry) => {
        telemetry.report("succeeded", 200);
      },
    );

    expect(JSON.stringify(meter.adds)).not.toContain(REQUEST_ID);
  });

  it("records a failed 500 when the body never reported", async () => {
    const meter = mockMeter();

    await withRouteTelemetry(
      { routeName: "identity.user.list", method: "GET" },
      REQUEST_ID,
      async () => undefined,
    );

    // The only honest reading of "the handler did not say".
    expect(meter.adds[0]?.attributes).toEqual(
      expect.objectContaining({
        "http.response.status_code": 500,
        outcome: "failed",
      }),
    );
  });

  it("records a measurement even when the body throws", async () => {
    const meter = mockMeter();

    await expect(
      withRouteTelemetry(
        { routeName: "identity.user.list", method: "GET" },
        REQUEST_ID,
        async () => {
          throw new Error("the adapter itself failed");
        },
      ),
    ).rejects.toThrow();

    expect(meter.adds).toHaveLength(1);
  });
});

describe("failure containment", () => {
  it("returns the body's value when the tracer throws", async () => {
    vi.spyOn(trace, "getTracer").mockImplementation(() => {
      throw new Error("tracer is broken");
    });

    await expect(
      withRouteTelemetry(
        { routeName: "identity.user.list", method: "GET" },
        REQUEST_ID,
        async (telemetry) => {
          telemetry.report("succeeded", 200);

          return "response";
        },
      ),
    ).resolves.toBe("response");
  });

  it("returns the body's value when the meter throws", async () => {
    vi.spyOn(metrics, "getMeter").mockImplementation(() => {
      throw new Error("meter is broken");
    });
    resetTelemetryInstruments();

    await expect(
      withRouteTelemetry(
        { routeName: "identity.user.list", method: "GET" },
        REQUEST_ID,
        async (telemetry) => {
          telemetry.report("succeeded", 200);

          return "response";
        },
      ),
    ).resolves.toBe("response");
  });

  it("runs the body exactly once", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    const run = vi.fn(async () => "response");

    await withRouteTelemetry(
      { routeName: "identity.user.list", method: "GET" },
      REQUEST_ID,
      run,
    );

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("captures a failure without throwing", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    await withRouteTelemetry(
      { routeName: "identity.user.list", method: "GET" },
      REQUEST_ID,
      async (telemetry) => {
        expect(() =>
          telemetry.captureFailure(
            new Error("defect"),
            ERROR_CODE.INTERNAL_ERROR,
          ),
        ).not.toThrow();
        telemetry.report("failed", 500, ERROR_CODE.INTERNAL_ERROR);
      },
    );
  });
});
