import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  InMemoryMetricExporter,
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  context as otelContext,
  metrics as otelMetrics,
  trace,
} from "@opentelemetry/api";
import { loadEnvConfig } from "@next/env";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

loadEnvConfig(process.cwd());

const {
  createStorageTestClient,
  deleteKeysUnderPrefix,
  ensureTestBucket,
  readStorageTestTarget,
  sha256Hex,
  testBytes,
} = await import("../fixtures/storage.fixture");

const {
  closeStorageClient,
  createUploadIntent,
  defineUploadPolicy,
  UPLOAD_INSPECTION,
} = await import("@/platform/storage/index.server");
const { getStorageKeyScope } = await import("@/platform/storage/config");
const { buildStorageKey, STORAGE_NAMESPACE, storageScopePrefix } =
  await import("@/platform/storage/storage-key");
const { requireStorageProvider } =
  await import("@/platform/storage/provider/storage-client.server");
const { METRIC, resetTelemetryInstruments } =
  await import("@/platform/observability/index.server");
const { database } = await import("@/platform/database/index.server");

/**
 * Storage telemetry against a real S3-compatible object store.
 *
 * The unit suite already proves the decorator's shape with a provider double. What
 * only a real bucket can prove is that the spans and the failure counter describe
 * the operations that actually happen — a presign that signs, a head that misses,
 * a delete that succeeds — and that none of them carries the bucket, the key, the
 * endpoint, or the credential that made them work.
 *
 * A real tracer and a real meter are registered here, with in-memory exporters:
 * the wire format has its own suite, and what matters here is the content.
 */
const target = readStorageTestTarget();
const testClient = createStorageTestClient(target);
const scope = getStorageKeyScope();
const runPrefix = storageScopePrefix(scope);

const pdfPolicy = defineUploadPolicy({
  name: "telemetry.document",
  allowedFiles: [{ contentType: "application/pdf", extensions: ["pdf"] }],
  maxBytes: 4_096,
  inspection: UPLOAD_INSPECTION.OPTIONAL,
});

const spanExporter = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE,
);

let tracerProvider: TracerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let metricReader: PeriodicExportingMetricReader | undefined;
let contextManager: AsyncLocalStorageContextManager | undefined;
const createdObjectIds: string[] = [];

beforeAll(async () => {
  await ensureTestBucket(testClient, target.bucket);

  tracerProvider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter })],
  });
  // A long interval: every assertion below forces a collection explicitly, so
  // nothing waits for a timer and no timer is left armed between tests.
  metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 300_000,
    exportTimeoutMillis: 5_000,
  });
  meterProvider = new MeterProvider({ readers: [metricReader] });
  contextManager = new AsyncLocalStorageContextManager().enable();

  otelContext.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(tracerProvider);
  otelMetrics.setGlobalMeterProvider(meterProvider);
  resetTelemetryInstruments();
});

afterEach(() => {
  spanExporter.reset();
  metricExporter.reset();
});

afterAll(async () => {
  // The globals go first, then the providers, then the storage client, then the
  // objects: nothing is left recording, no reader interval survives, and no key
  // outside this run's prefix is touched.
  trace.disable();
  otelMetrics.disable();
  otelContext.disable();
  contextManager?.disable();
  resetTelemetryInstruments();

  await tracerProvider?.shutdown();
  await meterProvider?.shutdown();

  closeStorageClient();

  if (createdObjectIds.length > 0) {
    await database.storageUploadIntent.deleteMany({
      where: { objectId: { in: createdObjectIds } },
    });
    await database.storageObject.deleteMany({
      where: { id: { in: createdObjectIds } },
    });
  }

  await deleteKeysUnderPrefix(testClient, target.bucket, runPrefix);
  testClient.destroy();
});

function spanNames(): readonly string[] {
  return spanExporter.getFinishedSpans().map((span) => span.name);
}

function spanAttributesFor(name: string): Record<string, unknown> {
  const span = spanExporter
    .getFinishedSpans()
    .find((candidate) => candidate.name === name);

  expect(span, `expected a span named ${name}`).toBeDefined();

  return { ...span?.attributes };
}

/** Every metric data point the reader can see, flattened to name plus attributes. */
async function collectedMetrics(): Promise<
  readonly Readonly<{ name: string; attributes: Record<string, unknown> }>[]
> {
  const collection = await metricReader?.collect();

  return (collection?.resourceMetrics.scopeMetrics ?? []).flatMap((scope) =>
    scope.metrics.flatMap((metric) =>
      metric.dataPoints.map((point) => ({
        name: metric.descriptor.name,
        attributes: { ...point.attributes },
      })),
    ),
  );
}

describe("a healthy provider operation", () => {
  it("emits one span naming the operation and the outcome", async () => {
    const declaration = {
      extension: "pdf",
      contentType: "application/pdf",
      sizeBytes: 512,
      checksumSha256: sha256Hex(testBytes(512)),
    };

    const intent = await createUploadIntent({
      policy: pdfPolicy,
      file: declaration,
    });

    createdObjectIds.push(intent.objectId);

    expect(spanNames()).toContain("storage.presign_upload");
    expect(spanAttributesFor("storage.presign_upload")).toEqual({
      "storage.operation": "storage.presign_upload",
      "storage.outcome": "succeeded",
      "app.outcome": "succeeded",
    });
  });

  it("names the database boundary it crossed as well", async () => {
    await createUploadIntent({
      policy: pdfPolicy,
      file: {
        extension: "pdf",
        contentType: "application/pdf",
        sizeBytes: 256,
        checksumSha256: sha256Hex(testBytes(256)),
      },
    }).then((intent) => createdObjectIds.push(intent.objectId));

    expect(spanNames()).toContain("db.storage.upload_intent.create");
  });

  it("counts no failure", async () => {
    await createUploadIntent({
      policy: pdfPolicy,
      file: {
        extension: "pdf",
        contentType: "application/pdf",
        sizeBytes: 128,
        checksumSha256: sha256Hex(testBytes(128)),
      },
    }).then((intent) => createdObjectIds.push(intent.objectId));

    const metrics = await collectedMetrics();

    expect(
      metrics.filter((entry) => entry.name === METRIC.STORAGE_FAILURES),
    ).toEqual([]);
  });
});

describe("a provider failure", () => {
  it("counts the closed failure code and nothing else", async () => {
    const provider = requireStorageProvider();
    // A well-formed key that names nothing: built by the platform's own builder,
    // so the failure under test is a missing object rather than a rejected key.
    const missingKey = buildStorageKey(scope, STORAGE_NAMESPACE.OBJECTS);

    await expect(provider.headObject(missingKey)).rejects.toThrow();

    expect(spanAttributesFor("storage.head")).toEqual({
      "storage.operation": "storage.head",
      "storage.outcome": "failed",
      "storage.failure.code": "not-found",
      "app.outcome": "failed",
      "app.error.code": "not-found",
    });

    const failures = (await collectedMetrics()).filter(
      (entry) => entry.name === METRIC.STORAGE_FAILURES,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]?.attributes).toEqual({
      operation: "storage.head",
      failure_code: "not-found",
    });
  });

  it("changes nothing about the provider's own answer", async () => {
    const provider = requireStorageProvider();

    // The failure is the adapter's closed error, unchanged by the decorator.
    await expect(
      provider.headObject(buildStorageKey(scope, STORAGE_NAMESPACE.OBJECTS)),
    ).rejects.toMatchObject({ failure: "not-found" });
  });
});

describe("what a storage span never carries", () => {
  it("names no bucket, key, endpoint, credential, or content type", async () => {
    const intent = await createUploadIntent({
      policy: pdfPolicy,
      file: {
        extension: "pdf",
        contentType: "application/pdf",
        sizeBytes: 64,
        checksumSha256: sha256Hex(testBytes(64)),
      },
    });

    createdObjectIds.push(intent.objectId);

    const provider = requireStorageProvider();

    await expect(
      provider.headObject(buildStorageKey(scope, STORAGE_NAMESPACE.OBJECTS)),
    ).rejects.toThrow();

    const serialized = JSON.stringify([
      spanExporter.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: span.attributes,
      })),
      await collectedMetrics(),
    ]);

    for (const forbidden of [
      target.bucket,
      target.endpoint ?? "http://127.0.0.1:9000",
      target.accessKeyId ?? "storagetestuser",
      runPrefix,
      intent.objectId,
      intent.intentId,
      "application/pdf",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });
});
