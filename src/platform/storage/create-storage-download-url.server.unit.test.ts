import { beforeEach, describe, expect, it, vi } from "vitest";

const getStorageConfiguration = vi.hoisted(() => vi.fn());
const requireStorageProvider = vi.hoisted(() => vi.fn());
const findStorageObjectById = vi.hoisted(() => vi.fn());

vi.mock("./config", () => ({
  getStorageConfiguration,
  getStorageKeyScope: vi.fn(),
}));
vi.mock("./provider/storage-client.server", () => ({ requireStorageProvider }));
vi.mock("./storage-repository.server", () => ({ findStorageObjectById }));

const { createStorageDownloadUrl } =
  await import("./create-storage-download-url.server");
const { STORAGE_INSPECTION_RESULT, STORAGE_OBJECT_STATUS } =
  await import("./storage-object");
const { STORAGE_PROVIDER_FAILURE, StorageProviderError } =
  await import("./provider/storage-provider");

const FINAL_KEY = "next-fullstack-starter/test/run-1/objects/abcdef01";

const configuration = {
  enabled: true,
  region: "us-east-1",
  bucket: "application-uploads",
  forcePathStyle: false,
  keyPrefix: "next-fullstack-starter",
  connectTimeoutMs: 5_000,
  requestTimeoutMs: 15_000,
  uploadUrlTtlSeconds: 900,
  downloadUrlTtlSeconds: 300,
  uploadIntentTtlSeconds: 900,
  finalizeLeaseMs: 30_000,
  maxUploadBytes: 4096,
};

const readyObject = {
  id: "object-1",
  status: STORAGE_OBJECT_STATUS.READY,
  objectKey: FINAL_KEY,
  contentType: "application/pdf",
  sizeBytes: BigInt(512),
  checksumSha256: "a".repeat(64),
  etag: "final-tag",
  inspectionResult: STORAGE_INSPECTION_RESULT.CLEAN,
  inspectionReason: null,
  readyAt: new Date("2026-08-02T12:00:00.000Z"),
  quarantinedAt: null,
  createdAt: new Date("2026-08-02T11:59:00.000Z"),
};

const createPresignedDownload = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getStorageConfiguration.mockReturnValue(configuration);
  createPresignedDownload.mockResolvedValue("https://signed.example/object");
  requireStorageProvider.mockReturnValue({ createPresignedDownload });
  findStorageObjectById.mockResolvedValue(readyObject);
});

describe("what may be downloaded", () => {
  it("signs a link for a ready object", async () => {
    const link = await createStorageDownloadUrl({ objectId: "object-1" });

    expect(link.url).toBe("https://signed.example/object");
    expect(createPresignedDownload).toHaveBeenCalledWith({
      key: FINAL_KEY,
      expiresInSeconds: 300,
      contentType: "application/pdf",
    });
  });

  it("refuses when storage is disabled", async () => {
    getStorageConfiguration.mockReturnValue({
      ...configuration,
      enabled: false,
    });

    await expect(
      createStorageDownloadUrl({ objectId: "object-1" }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });

  it("answers a missing object and every unready state identically", async () => {
    // The difference between "no such file" and "that file was withheld" is
    // information about what somebody uploaded.
    findStorageObjectById.mockResolvedValue(null);

    const missing = (await createStorageDownloadUrl({
      objectId: "object-1",
    }).catch((error: unknown) => error)) as Error;

    for (const status of [
      STORAGE_OBJECT_STATUS.PENDING,
      STORAGE_OBJECT_STATUS.QUARANTINED,
      STORAGE_OBJECT_STATUS.REJECTED,
      STORAGE_OBJECT_STATUS.EXPIRED,
    ]) {
      findStorageObjectById.mockResolvedValue({ ...readyObject, status });

      const refused = (await createStorageDownloadUrl({
        objectId: "object-1",
      }).catch((error: unknown) => error)) as Error & { code?: string };

      expect(refused.constructor.name, status).toBe(missing.constructor.name);
      expect(refused.code, status).toBe("NOT_FOUND");
    }

    expect(createPresignedDownload).not.toHaveBeenCalled();
  });
});

describe("the lifetime of the link", () => {
  it("uses the configured default", async () => {
    await createStorageDownloadUrl({ objectId: "object-1" });

    expect(createPresignedDownload.mock.calls[0]?.[0]).toMatchObject({
      expiresInSeconds: 300,
    });
  });

  it("honours a shorter request", async () => {
    await createStorageDownloadUrl({ objectId: "object-1", ttlSeconds: 30 });

    expect(createPresignedDownload.mock.calls[0]?.[0]).toMatchObject({
      expiresInSeconds: 30,
    });
  });

  it("clamps a longer request to the configured maximum", async () => {
    await createStorageDownloadUrl({
      objectId: "object-1",
      ttlSeconds: 86_400,
    });

    expect(createPresignedDownload.mock.calls[0]?.[0]).toMatchObject({
      expiresInSeconds: 300,
    });
  });

  it("refuses a lifetime that is not positive", async () => {
    await expect(
      createStorageDownloadUrl({ objectId: "object-1", ttlSeconds: 0 }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      createStorageDownloadUrl({ objectId: "object-1", ttlSeconds: -5 }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("reports when the link stops working", async () => {
    const link = await createStorageDownloadUrl({
      objectId: "object-1",
      ttlSeconds: 60,
    });

    expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("the filename and the media type", () => {
  it("carries a safe attachment header for a caller-chosen name", async () => {
    await createStorageDownloadUrl({
      objectId: "object-1",
      filename: "تقرير.pdf",
    });

    const request = createPresignedDownload.mock.calls[0]?.[0] as {
      contentDisposition: string;
    };

    expect(request.contentDisposition).toContain("attachment");
    expect(request.contentDisposition).toContain("filename*=UTF-8''");
  });

  it("refuses a filename that could break a header", async () => {
    await expect(
      createStorageDownloadUrl({
        objectId: "object-1",
        filename: "a\r\nSet-Cookie: x=1",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(findStorageObjectById).not.toHaveBeenCalled();
  });

  it("sends no disposition when the caller chose no name", async () => {
    await createStorageDownloadUrl({ objectId: "object-1" });

    expect(createPresignedDownload.mock.calls[0]?.[0]).not.toHaveProperty(
      "contentDisposition",
    );
  });

  it("refuses to relabel the object as another media type", async () => {
    // Relabelling a PDF as `text/html` is what turns a stored file into stored
    // XSS on the bucket's own origin.
    await expect(
      createStorageDownloadUrl({
        objectId: "object-1",
        contentType: "text/html",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("accepts the object's own media type as an explicit override", async () => {
    await expect(
      createStorageDownloadUrl({
        objectId: "object-1",
        contentType: "application/pdf",
      }),
    ).resolves.toMatchObject({ url: "https://signed.example/object" });
  });
});

describe("when the provider will not sign", () => {
  it("reports a dependency failure rather than a provider error", async () => {
    createPresignedDownload.mockRejectedValue(
      new StorageProviderError(STORAGE_PROVIDER_FAILURE.UNAVAILABLE),
    );

    await expect(
      createStorageDownloadUrl({ objectId: "object-1" }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });

  it("passes an unexpected failure through unchanged", async () => {
    createPresignedDownload.mockRejectedValue(new TypeError("a defect"));

    await expect(
      createStorageDownloadUrl({ objectId: "object-1" }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
