import { trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  METRIC,
  recordRouteRequest,
  resetProductionTelemetry,
  resetTelemetryConfiguration,
  shutdownProductionTelemetry,
  startProductionTelemetry,
  TELEMETRY_PROCESS_TYPE,
  TELEMETRY_STATUS,
  withActiveSpan,
} from "@/platform/observability/index.server";

import {
  metricNamesOf,
  OTLP_METRICS_PATH,
  OTLP_TRACES_PATH,
  resourceAttributesOf,
  spansOf,
  startOtlpReceiver,
  type OtlpReceiver,
} from "../fixtures/otlp-receiver.fixture";

/**
 * The only suite in this repository that switches telemetry on, and the only one
 * that exercises the real OTLP exporters against a real HTTP endpoint.
 *
 * Everything else asserts on the contract through the OpenTelemetry API or an
 * in-memory double, which proves the application produces the right spans and
 * metrics. This suite proves the other half: that what the application produces is
 * serialized, batched, addressed, authenticated, and delivered — and that what
 * arrives carries nothing it should not.
 */
const OTLP_HEADER_SECRET = "integration-suite-bearer-token";

let receiver: OtlpReceiver | undefined;

/**
 * Starts telemetry against a receiver, with a short export interval.
 *
 * The metric interval is the schema's floor, so a metric batch arrives inside a
 * test rather than a minute later. Nothing here sleeps for a fixed period: every
 * wait below ends on a delivered request.
 */
async function startAgainst(
  current: OtlpReceiver,
  processType: (typeof TELEMETRY_PROCESS_TYPE)[keyof typeof TELEMETRY_PROCESS_TYPE],
  extra: Record<string, string> = {},
): Promise<void> {
  vi.stubEnv("TELEMETRY_ENABLED", "true");
  vi.stubEnv("TELEMETRY_OTLP_ENDPOINT", current.endpoint);
  // The floor for both, so a metric batch arrives inside a test rather than a
  // minute later, and the timeout still satisfies the reader's own requirement
  // that a collection cannot outlive the gap before the next one.
  vi.stubEnv("TELEMETRY_METRIC_EXPORT_INTERVAL_MS", "1000");
  vi.stubEnv("TELEMETRY_EXPORT_TIMEOUT_MS", "1000");

  for (const [name, value] of Object.entries(extra)) {
    vi.stubEnv(name, value);
  }

  resetTelemetryConfiguration();
  resetProductionTelemetry();

  const handle = await startProductionTelemetry({ processType });

  expect(handle.status).toBe(TELEMETRY_STATUS.STARTED);
}

beforeEach(() => {
  resetProductionTelemetry();
  resetTelemetryConfiguration();
});

afterEach(async () => {
  // In `finally` terms: the SDK first, so no exporter can be mid-request when the
  // receiver's socket closes, then the receiver, so no port is left listening.
  await shutdownProductionTelemetry();
  resetProductionTelemetry();
  resetTelemetryConfiguration();
  await receiver?.close();
  receiver = undefined;
  vi.unstubAllEnvs();
});

describe("trace export", () => {
  it("delivers a batch of spans over OTLP/HTTP", async () => {
    receiver = await startOtlpReceiver();
    await startAgainst(receiver, TELEMETRY_PROCESS_TYPE.WEB);

    await withActiveSpan(
      "route.identity.user.list",
      { "app.operation.name": "identity.user.list" },
      async (span) => {
        span.setOutcome("succeeded");
      },
    );

    await shutdownProductionTelemetry();

    expect(await receiver.waitFor(OTLP_TRACES_PATH, 1)).toBe(true);

    const spans = receiver
      .traceRequests()
      .flatMap((entry) => spansOf(entry.body));

    expect(spans.map((span) => span.name)).toContain(
      "route.identity.user.list",
    );
  });

  it("carries the four resource attributes and no host or process identity", async () => {
    receiver = await startOtlpReceiver();
    await startAgainst(receiver, TELEMETRY_PROCESS_TYPE.WEB, {
      APP_RELEASE: "1.2.3",
    });

    await withActiveSpan("probe", {}, async () => undefined);
    await shutdownProductionTelemetry();

    expect(await receiver.waitFor(OTLP_TRACES_PATH, 1)).toBe(true);

    const attributes = resourceAttributesOf(
      receiver.traceRequests()[0]?.body ?? null,
      "resourceSpans",
    );

    expect(attributes).toEqual({
      "service.name": "next-fullstack-starter",
      "service.version": "1.2.3",
      "deployment.environment.name": "test",
      "app.process.type": "web",
    });
  });

  it("omits the service version when no release is configured", async () => {
    receiver = await startOtlpReceiver();
    await startAgainst(receiver, TELEMETRY_PROCESS_TYPE.WEB);

    await withActiveSpan("probe", {}, async () => undefined);
    await shutdownProductionTelemetry();

    expect(await receiver.waitFor(OTLP_TRACES_PATH, 1)).toBe(true);

    const attributes = resourceAttributesOf(
      receiver.traceRequests()[0]?.body ?? null,
      "resourceSpans",
    );

    expect(Object.keys(attributes).sort()).toEqual([
      "app.process.type",
      "deployment.environment.name",
      "service.name",
    ]);
  });

  it("labels the worker process differently from the web process", async () => {
    receiver = await startOtlpReceiver();
    await startAgainst(receiver, TELEMETRY_PROCESS_TYPE.WORKER);

    await withActiveSpan("jobs.execute", {}, async () => undefined);
    await shutdownProductionTelemetry();

    expect(await receiver.waitFor(OTLP_TRACES_PATH, 1)).toBe(true);

    const attributes = resourceAttributesOf(
      receiver.traceRequests()[0]?.body ?? null,
      "resourceSpans",
    );

    expect(attributes["app.process.type"]).toBe("worker");
  });

  it("preserves parent and child relationships in one trace", async () => {
    receiver = await startOtlpReceiver();
    await startAgainst(receiver, TELEMETRY_PROCESS_TYPE.WEB);

    await withActiveSpan("parent", {}, async () => {
      await withActiveSpan("child", {}, async () => undefined);
    });

    await shutdownProductionTelemetry();

    expect(await receiver.waitFor(OTLP_TRACES_PATH, 1)).toBe(true);

    const spans = receiver
      .traceRequests()
      .flatMap((entry) => spansOf(entry.body));
    const parent = spans.find((span) => span.name === "parent");
    const child = spans.find((span) => span.name === "child");

    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child?.traceId).toBe(parent?.traceId);
    expect(child?.parentSpanId).toBe(parent?.spanId);
  });
});

describe("metric export", () => {
  it("delivers a metric batch carrying the closed instrument names", async () => {
    receiver = await startOtlpReceiver();
    await startAgainst(receiver, TELEMETRY_PROCESS_TYPE.WEB);

    recordRouteRequest({
      routeName: "identity.user.list",
      method: "GET",
      statusCode: 200,
      outcome: "succeeded",
      durationMs: 12,
    });

    await shutdownProductionTelemetry();

    expect(await receiver.waitFor(OTLP_METRICS_PATH, 1)).toBe(true);

    const names = receiver
      .metricRequests()
      .flatMap((entry) => metricNamesOf(entry.body));

    expect(names).toContain(METRIC.ROUTE_REQUESTS);
    expect(names).toContain(METRIC.ROUTE_DURATION);
  });

  it("carries the same resource metadata as the traces", async () => {
    receiver = await startOtlpReceiver();
    await startAgainst(receiver, TELEMETRY_PROCESS_TYPE.WORKER);

    recordRouteRequest({
      routeName: "identity.user.list",
      method: "GET",
      statusCode: 200,
      outcome: "succeeded",
      durationMs: 1,
    });

    await shutdownProductionTelemetry();

    expect(await receiver.waitFor(OTLP_METRICS_PATH, 1)).toBe(true);

    const attributes = resourceAttributesOf(
      receiver.metricRequests()[0]?.body ?? null,
      "resourceMetrics",
    );

    expect(attributes["service.name"]).toBe("next-fullstack-starter");
    expect(attributes["app.process.type"]).toBe("worker");
  });

  it("records durations in seconds", async () => {
    receiver = await startOtlpReceiver();
    await startAgainst(receiver, TELEMETRY_PROCESS_TYPE.WEB);

    recordRouteRequest({
      routeName: "identity.user.list",
      method: "GET",
      statusCode: 200,
      outcome: "succeeded",
      durationMs: 2_500,
    });

    await shutdownProductionTelemetry();

    expect(await receiver.waitFor(OTLP_METRICS_PATH, 1)).toBe(true);

    const raw = receiver
      .metricRequests()
      .map((entry) => entry.raw)
      .join("");

    // The unit travels with the instrument, so a dashboard cannot mistake
    // milliseconds for seconds.
    expect(raw).toContain('"unit":"s"');
  });
});

describe("the OTLP credential", () => {
  it("travels as a request header and never inside the payload", async () => {
    receiver = await startOtlpReceiver();
    await startAgainst(receiver, TELEMETRY_PROCESS_TYPE.WEB, {
      TELEMETRY_OTLP_HEADERS: `authorization=${OTLP_HEADER_SECRET}`,
    });

    await withActiveSpan("probe", {}, async () => undefined);
    await shutdownProductionTelemetry();

    expect(await receiver.waitFor(OTLP_TRACES_PATH, 1)).toBe(true);

    const request = receiver.traceRequests()[0];

    expect(request?.headers.authorization).toBe(OTLP_HEADER_SECRET);

    // A credential in the body would be a credential in the collector's own
    // storage, and in every span that document produced.
    for (const entry of receiver.allRequests()) {
      expect(entry.raw).not.toContain(OTLP_HEADER_SECRET);
    }
  });

  it("sends no credential when none is configured", async () => {
    receiver = await startOtlpReceiver();
    await startAgainst(receiver, TELEMETRY_PROCESS_TYPE.WEB);

    await withActiveSpan("probe", {}, async () => undefined);
    await shutdownProductionTelemetry();

    expect(await receiver.waitFor(OTLP_TRACES_PATH, 1)).toBe(true);

    expect(receiver.traceRequests()[0]?.headers.authorization).toBeUndefined();
  });
});

describe("an endpoint that cannot be reached", () => {
  it("changes nothing about the operation, and leaves nothing open", async () => {
    // A receiver started and immediately closed leaves a port with no listener,
    // which is the closest thing to "the collector went away" that needs no
    // network.
    const closed = await startOtlpReceiver();
    const endpoint = closed.endpoint;

    await closed.close();

    vi.stubEnv("TELEMETRY_ENABLED", "true");
    vi.stubEnv("TELEMETRY_OTLP_ENDPOINT", endpoint);
    vi.stubEnv("TELEMETRY_EXPORT_TIMEOUT_MS", "500");
    resetTelemetryConfiguration();
    resetProductionTelemetry();

    const handle = await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });

    expect(handle.status).toBe(TELEMETRY_STATUS.STARTED);

    const result = await withActiveSpan("probe", {}, async (span) => {
      span.setOutcome("succeeded");

      return "business-result";
    });

    // The operation's value is the operation's value, whatever the collector did.
    expect(result).toBe("business-result");

    await expect(shutdownProductionTelemetry()).resolves.toBeUndefined();
  });

  it("refuses an export without failing the application", async () => {
    receiver = await startOtlpReceiver({ status: 503 });
    await startAgainst(receiver, TELEMETRY_PROCESS_TYPE.WEB);

    const result = await withActiveSpan("probe", {}, async () => "value");

    expect(result).toBe("value");

    await expect(shutdownProductionTelemetry()).resolves.toBeUndefined();
  });

  it("bounds an export that never answers", async () => {
    // The receiver holds every response for longer than the export timeout, so the
    // exporter's own deadline is what ends the attempt. The assertion is that the
    // shutdown still completes.
    receiver = await startOtlpReceiver({ delayMs: 5_000 });
    await startAgainst(receiver, TELEMETRY_PROCESS_TYPE.WEB, {
      TELEMETRY_EXPORT_TIMEOUT_MS: "500",
      TELEMETRY_METRIC_EXPORT_INTERVAL_MS: "1000",
    });

    await withActiveSpan("probe", {}, async () => undefined);

    await expect(shutdownProductionTelemetry()).resolves.toBeUndefined();
  });
});

describe("shutdown", () => {
  it("releases the providers and stops recording", async () => {
    receiver = await startOtlpReceiver();
    await startAgainst(receiver, TELEMETRY_PROCESS_TYPE.WEB);

    expect(trace.getTracer("probe").startSpan("probe").isRecording()).toBe(
      true,
    );

    await shutdownProductionTelemetry();

    expect(trace.getTracer("probe").startSpan("probe").isRecording()).toBe(
      false,
    );
  });

  it("sends nothing more after it has completed", async () => {
    receiver = await startOtlpReceiver();
    await startAgainst(receiver, TELEMETRY_PROCESS_TYPE.WEB);

    await withActiveSpan("before-shutdown", {}, async () => undefined);
    await shutdownProductionTelemetry();

    expect(await receiver.waitFor(OTLP_TRACES_PATH, 1)).toBe(true);

    const delivered = receiver.allRequests().length;

    receiver.reset();

    await withActiveSpan("after-shutdown", {}, async () => undefined);

    expect(delivered).toBeGreaterThan(0);
    expect(receiver.allRequests()).toEqual([]);
  });
});
