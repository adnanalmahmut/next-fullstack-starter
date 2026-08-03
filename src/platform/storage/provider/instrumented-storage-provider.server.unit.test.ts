import { metrics, trace, type Meter, type Tracer } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetTelemetryInstruments } from "@/platform/observability/metrics.server";

import {
  instrumentStorageProvider,
  STORAGE_OPERATION,
  STORAGE_OPERATIONS,
  STORAGE_SPAN_ATTRIBUTE,
  UNCLASSIFIED_STORAGE_FAILURE,
} from "./instrumented-storage-provider.server";
import {
  STORAGE_PROVIDER_FAILURE,
  StorageProviderError,
  type StorageProvider,
} from "./storage-provider";

const BUCKET = "customer-documents";
const OBJECT_KEY = "next-fullstack-starter/documents/8f3c/passport-scan.pdf";
const SIGNED_URL = `https://${BUCKET}.s3.example.com/${OBJECT_KEY}?X-Amz-Signature=deadbeef`;

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

  vi.spyOn(metrics, "getMeter").mockReturnValue({
    createCounter: (name: string) => ({
      add: (_value: number, attributes?: unknown) => {
        adds.push({ name, attributes });
      },
    }),
    createHistogram: () => ({ record: () => undefined }),
  } as unknown as Meter);

  resetTelemetryInstruments();

  return adds;
}

function createProviderDouble(
  overrides: Partial<StorageProvider> = {},
): StorageProvider {
  return {
    createPresignedUpload: async () => ({
      method: "POST",
      url: SIGNED_URL,
      fields: { key: OBJECT_KEY },
    }),
    headObject: async () => ({
      sizeBytes: 1,
      contentType: "application/pdf",
      etag: "abc",
      checksumSha256: null,
    }),
    computeObjectChecksum: async () => "abc",
    copyObjectConditionally: async () => "def",
    deleteObject: async () => undefined,
    createPresignedDownload: async () => SIGNED_URL,
    checkBucket: async () => undefined,
    destroy: () => undefined,
    ...overrides,
  };
}

describe("the operation registry", () => {
  it("names the six data operations and nothing else", () => {
    expect(STORAGE_OPERATIONS).toEqual([
      "storage.presign_upload",
      "storage.head",
      "storage.stream",
      "storage.copy",
      "storage.delete",
      "storage.presign_download",
    ]);
  });
});

describe("a successful operation", () => {
  it("opens a span carrying the operation and the outcome", async () => {
    const span = createSpanDouble();
    const startSpan = mockTracer(span);
    const provider = instrumentStorageProvider(createProviderDouble());

    await provider.headObject(OBJECT_KEY);

    expect(startSpan).toHaveBeenCalledWith(STORAGE_OPERATION.HEAD, {
      attributes: {
        [STORAGE_SPAN_ATTRIBUTE.OPERATION]: STORAGE_OPERATION.HEAD,
      },
    });
    expect(span.setAttributes).toHaveBeenCalledWith({
      [STORAGE_SPAN_ATTRIBUTE.OUTCOME]: "succeeded",
    });
  });

  it("returns the provider's answer unchanged", async () => {
    mockTracer(createSpanDouble());

    const provider = instrumentStorageProvider(createProviderDouble());

    await expect(
      provider.createPresignedDownload({
        key: OBJECT_KEY,
        expiresInSeconds: 60,
      }),
    ).resolves.toBe(SIGNED_URL);
  });

  it("counts no failure", async () => {
    const adds = mockMeter();
    const provider = instrumentStorageProvider(createProviderDouble());

    await provider.deleteObject(OBJECT_KEY);

    expect(adds).toEqual([]);
  });
});

describe("a failed operation", () => {
  it("records the closed failure code as a span attribute and a count", async () => {
    const span = createSpanDouble();

    mockTracer(span);

    const adds = mockMeter();
    const provider = instrumentStorageProvider(
      createProviderDouble({
        copyObjectConditionally: async () => {
          throw new StorageProviderError(
            STORAGE_PROVIDER_FAILURE.PRECONDITION_FAILED,
          );
        },
      }),
    );

    await expect(
      provider.copyObjectConditionally({
        sourceKey: OBJECT_KEY,
        destinationKey: OBJECT_KEY,
        contentType: "application/pdf",
        sourceEtag: "abc",
      }),
    ).rejects.toBeInstanceOf(StorageProviderError);

    expect(span.setAttributes).toHaveBeenCalledWith({
      [STORAGE_SPAN_ATTRIBUTE.OUTCOME]: "failed",
      [STORAGE_SPAN_ATTRIBUTE.FAILURE_CODE]: "precondition-failed",
    });
    expect(adds[0]?.attributes).toEqual({
      operation: STORAGE_OPERATION.COPY,
      failure_code: "precondition-failed",
    });
  });

  it("labels an unclassified throw rather than borrowing a provider code", async () => {
    mockTracer(createSpanDouble());

    const adds = mockMeter();
    const provider = instrumentStorageProvider(
      createProviderDouble({
        headObject: async () => {
          throw new TypeError("a defect above the adapter");
        },
      }),
    );

    await expect(provider.headObject(OBJECT_KEY)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(adds[0]?.attributes).toEqual({
      operation: STORAGE_OPERATION.HEAD,
      failure_code: UNCLASSIFIED_STORAGE_FAILURE,
    });
  });

  it("propagates the failure unchanged", async () => {
    mockTracer(createSpanDouble());

    const failure = new StorageProviderError(
      STORAGE_PROVIDER_FAILURE.ACCESS_DENIED,
    );
    const provider = instrumentStorageProvider(
      createProviderDouble({
        deleteObject: async () => {
          throw failure;
        },
      }),
    );

    // Telemetry observes a storage operation; it never decides one.
    await expect(provider.deleteObject(OBJECT_KEY)).rejects.toBe(failure);
  });
});

describe("what a storage span may never carry", () => {
  it("carries no bucket, key, signed URL, or content type", async () => {
    const span = createSpanDouble();
    const startSpan = mockTracer(span);
    const adds = mockMeter();
    const provider = instrumentStorageProvider(createProviderDouble());

    await provider.createPresignedUpload({
      key: OBJECT_KEY,
      contentType: "application/pdf",
      sizeBytes: 1_024,
      checksumSha256: "a".repeat(64),
      expiresInSeconds: 900,
    });
    await provider.createPresignedDownload({
      key: OBJECT_KEY,
      expiresInSeconds: 60,
      contentDisposition: 'attachment; filename="passport-scan.pdf"',
    });

    const serialized = JSON.stringify([
      startSpan.mock.calls,
      span.setAttribute.mock.calls,
      span.setAttributes.mock.calls,
      adds,
    ]);

    for (const forbidden of [
      BUCKET,
      OBJECT_KEY,
      "passport-scan.pdf",
      "X-Amz-Signature",
      "application/pdf",
      "s3.example.com",
      "a".repeat(64),
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });
});

describe("the health probe is not a business operation", () => {
  it("passes the bucket check through untouched", async () => {
    const span = createSpanDouble();
    const startSpan = mockTracer(span);
    const adds = mockMeter();
    const checkBucket = vi.fn(async () => {
      throw new StorageProviderError(STORAGE_PROVIDER_FAILURE.BUCKET_NOT_FOUND);
    });
    const provider = instrumentStorageProvider(
      createProviderDouble({ checkBucket }),
    );

    await expect(provider.checkBucket()).rejects.toBeInstanceOf(
      StorageProviderError,
    );

    // A probe runs on a load balancer's schedule. Counting its failures would make
    // `app.storage.failures` a graph of probe noise rather than of uploads that did
    // not work.
    expect(startSpan).not.toHaveBeenCalled();
    expect(adds).toEqual([]);
    expect(checkBucket).toHaveBeenCalledTimes(1);
  });

  it("passes teardown through untouched", () => {
    const destroy = vi.fn();
    const provider = instrumentStorageProvider(
      createProviderDouble({ destroy }),
    );

    provider.destroy();

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe("failure containment", () => {
  it("returns the provider's answer when the tracer throws", async () => {
    vi.spyOn(trace, "getTracer").mockImplementation(() => {
      throw new Error("tracer is broken");
    });

    const provider = instrumentStorageProvider(createProviderDouble());

    await expect(
      provider.computeObjectChecksum({
        key: OBJECT_KEY,
        maxBytes: 10,
      }),
    ).resolves.toBe("abc");
  });

  it("returns the provider's answer when the meter throws", async () => {
    mockTracer(createSpanDouble());
    vi.spyOn(metrics, "getMeter").mockImplementation(() => {
      throw new Error("meter is broken");
    });
    resetTelemetryInstruments();

    const failure = new StorageProviderError(
      STORAGE_PROVIDER_FAILURE.UNAVAILABLE,
    );
    const provider = instrumentStorageProvider(
      createProviderDouble({
        headObject: async () => {
          throw failure;
        },
      }),
    );

    await expect(provider.headObject(OBJECT_KEY)).rejects.toBe(failure);
  });

  it("calls the underlying operation exactly once", async () => {
    mockTracer(createSpanDouble());

    const deleteObject = vi.fn(async () => undefined);
    const provider = instrumentStorageProvider(
      createProviderDouble({ deleteObject }),
    );

    await provider.deleteObject(OBJECT_KEY);

    expect(deleteObject).toHaveBeenCalledTimes(1);
  });
});
