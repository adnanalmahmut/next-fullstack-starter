import { beforeEach, describe, expect, it, vi } from "vitest";

const getStorageConfiguration = vi.hoisted(() => vi.fn());
const getStorageKeyScope = vi.hoisted(() => vi.fn());
const requireStorageProvider = vi.hoisted(() => vi.fn());
const insertUploadIntent = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());

vi.mock("./config", () => ({ getStorageConfiguration, getStorageKeyScope }));
vi.mock("./provider/storage-client.server", () => ({ requireStorageProvider }));
vi.mock("./storage-repository.server", () => ({ insertUploadIntent }));
vi.mock("@/platform/observability/logger.server", () => ({
  logger: { info, warn: vi.fn(), error: vi.fn() },
}));

const { createUploadIntent } = await import("./create-upload-intent.server");
const { defineUploadPolicy } = await import("./upload-policy");

const policy = defineUploadPolicy({
  name: "test.fixture",
  allowedFiles: [{ contentType: "application/pdf", extensions: ["pdf"] }],
  maxBytes: 1024,
});

const CHECKSUM = "a".repeat(64);
const NOW = new Date("2026-08-02T12:00:00.000Z");

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

const createPresignedUpload = vi.fn();

const file = {
  contentType: "application/pdf",
  extension: "pdf",
  sizeBytes: 512,
  checksumSha256: CHECKSUM,
} as const;

beforeEach(() => {
  getStorageConfiguration.mockReset().mockReturnValue(configuration);
  getStorageKeyScope.mockReset().mockReturnValue({
    prefix: "next-fullstack-starter",
    environment: "test",
    testRunId: "run-1",
  });
  createPresignedUpload.mockReset().mockResolvedValue({
    method: "POST",
    url: "http://127.0.0.1:9000/application-uploads",
    fields: { key: "a-staging-key" },
  });
  requireStorageProvider.mockReset().mockReturnValue({ createPresignedUpload });
  insertUploadIntent
    .mockReset()
    .mockImplementation(
      (input: { objectKey: string; stagingKey: string; expiresAt: Date }) =>
        Promise.resolve({
          object: { id: "object-1", objectKey: input.objectKey },
          intent: { id: "intent-1", expiresAt: input.expiresAt },
        }),
    );
  info.mockReset();
});

describe("when storage is disabled", () => {
  it("refuses before anything is built", async () => {
    getStorageConfiguration.mockReturnValue({
      ...configuration,
      enabled: false,
    });

    await expect(createUploadIntent({ policy, file })).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });

    expect(requireStorageProvider).not.toHaveBeenCalled();
    expect(insertUploadIntent).not.toHaveBeenCalled();
  });
});

describe("validation comes first", () => {
  it("costs nothing when the declaration is refused", async () => {
    // No row, no key, no provider call: an oversized or disallowed file is
    // rejected before any of them exist.
    await expect(
      createUploadIntent({ policy, file: { ...file, sizeBytes: 99_999 } }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(insertUploadIntent).not.toHaveBeenCalled();
    expect(createPresignedUpload).not.toHaveBeenCalled();
  });

  it("applies the deployment ceiling as well as the policy limit", async () => {
    getStorageConfiguration.mockReturnValue({
      ...configuration,
      maxUploadBytes: 100,
    });

    await expect(
      createUploadIntent({ policy, file: { ...file, sizeBytes: 512 } }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("the intent it creates", () => {
  it("writes the row before it signs the form", async () => {
    const order: string[] = [];

    insertUploadIntent.mockImplementation((input: { expiresAt: Date }) => {
      order.push("insert");

      return Promise.resolve({
        object: { id: "object-1" },
        intent: { id: "intent-1", expiresAt: input.expiresAt },
      });
    });
    createPresignedUpload.mockImplementation(() => {
      order.push("sign");

      return Promise.resolve({ method: "POST", url: "http://x", fields: {} });
    });

    await createUploadIntent({ policy, file, now: NOW });

    // The other order would leave a client able to upload into staging with
    // nothing in the database that knows the object is there.
    expect(order).toEqual(["insert", "sign"]);
  });

  it("generates two independent keys in two namespaces", async () => {
    await createUploadIntent({ policy, file, now: NOW });

    const written = insertUploadIntent.mock.calls[0]?.[0] as {
      stagingKey: string;
      objectKey: string;
    };

    expect(written.stagingKey).toContain("/staging/");
    expect(written.objectKey).toContain("/objects/");
    expect(written.stagingKey.split("/").at(-1)).not.toBe(
      written.objectKey.split("/").at(-1),
    );
  });

  it("stores the hash of the token and returns the token once", async () => {
    const created = await createUploadIntent({ policy, file, now: NOW });

    const written = insertUploadIntent.mock.calls[0]?.[0] as {
      finalizeTokenHash: string;
    };

    expect(created.finalizeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(written.finalizeTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(written.finalizeTokenHash).not.toContain(created.finalizeToken);
  });

  it("expires the intent after the configured lifetime", async () => {
    await createUploadIntent({ policy, file, now: NOW });

    const written = insertUploadIntent.mock.calls[0]?.[0] as {
      expiresAt: Date;
    };

    expect(written.expiresAt.toISOString()).toBe("2026-08-02T12:15:00.000Z");
  });

  it("clamps the form's lifetime to the intent's", async () => {
    // A form that outlived its intent would let bytes land in staging that
    // nothing is left to promote.
    getStorageConfiguration.mockReturnValue({
      ...configuration,
      uploadUrlTtlSeconds: 900,
      uploadIntentTtlSeconds: 120,
    });

    await createUploadIntent({ policy, file, now: NOW });

    expect(createPresignedUpload.mock.calls[0]?.[0]).toMatchObject({
      expiresInSeconds: 120,
    });
  });

  it("signs the declared media type, size, and checksum", async () => {
    await createUploadIntent({ policy, file, now: NOW });

    expect(createPresignedUpload.mock.calls[0]?.[0]).toMatchObject({
      contentType: "application/pdf",
      sizeBytes: 512,
      checksumSha256: CHECKSUM,
    });
  });

  it("returns nothing about where the object will live", async () => {
    const created = await createUploadIntent({ policy, file, now: NOW });
    const written = insertUploadIntent.mock.calls[0]?.[0] as {
      objectKey: string;
    };

    expect(Object.keys(created).sort()).toEqual([
      "expiresAt",
      "finalizeToken",
      "intentId",
      "objectId",
      "upload",
    ]);
    expect(JSON.stringify(created)).not.toContain(written.objectKey);
  });
});

describe("what it logs", () => {
  it("names the intent, the object, and the policy, and nothing else", async () => {
    await createUploadIntent({
      policy,
      file,
      now: NOW,
      requestId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });

    const [fields, event] = info.mock.calls[0] ?? [];

    expect(event).toBe("storage.upload_intent.created");
    expect(Object.keys(fields as object).sort()).toEqual([
      "intentId",
      "objectId",
      "policyName",
      "requestId",
    ]);
  });

  it("never logs the token, a key, or the signed form", async () => {
    const created = await createUploadIntent({ policy, file, now: NOW });
    const written = insertUploadIntent.mock.calls[0]?.[0] as {
      stagingKey: string;
      objectKey: string;
      finalizeTokenHash: string;
    };

    const logged = JSON.stringify(info.mock.calls);

    expect(logged).not.toContain(created.finalizeToken);
    expect(logged).not.toContain(written.finalizeTokenHash);
    expect(logged).not.toContain(written.stagingKey);
    expect(logged).not.toContain(written.objectKey);
    expect(logged).not.toContain("application-uploads");
  });
});
