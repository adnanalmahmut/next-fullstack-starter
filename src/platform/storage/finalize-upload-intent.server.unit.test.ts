import { beforeEach, describe, expect, it, vi } from "vitest";

const getStorageConfiguration = vi.hoisted(() => vi.fn());
const getStorageKeyScope = vi.hoisted(() => vi.fn());
const requireStorageProvider = vi.hoisted(() => vi.fn());
const repository = vi.hoisted(() => ({
  claimUploadIntent: vi.fn(),
  completeUploadIntent: vi.fn(),
  failUploadIntent: vi.fn(),
  findStorageObjectById: vi.fn(),
  findUploadIntentById: vi.fn(),
  reclaimUploadIntent: vi.fn(),
  releaseUploadIntent: vi.fn(),
}));
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./config", () => ({ getStorageConfiguration, getStorageKeyScope }));
vi.mock("./provider/storage-client.server", () => ({ requireStorageProvider }));
vi.mock("./storage-repository.server", () => repository);
vi.mock("@/platform/observability/logger.server", () => ({ logger: log }));

const { finalizeUploadIntent } =
  await import("./finalize-upload-intent.server");
const { defineUploadPolicy, UPLOAD_INSPECTION } =
  await import("./upload-policy");
const { hashFinalizeToken, createFinalizeToken } =
  await import("./finalize-token");
const { STORAGE_PROVIDER_FAILURE, StorageProviderError } =
  await import("./provider/storage-provider");
const { INSPECTION_OUTCOME } = await import("./content-inspector");
const {
  STORAGE_INSPECTION_RESULT,
  STORAGE_OBJECT_STATUS,
  UPLOAD_INTENT_STATUS,
} = await import("./storage-object");

const CHECKSUM = "a".repeat(64);
const NOW = new Date("2026-08-02T12:00:00.000Z");
const STAGING_KEY = "next-fullstack-starter/test/run-1/staging/abcdef01";
const FINAL_KEY = "next-fullstack-starter/test/run-1/objects/abcdef01";

const policy = defineUploadPolicy({
  name: "test.fixture",
  allowedFiles: [{ contentType: "application/pdf", extensions: ["pdf"] }],
  maxBytes: 4096,
});

const scannedPolicy = defineUploadPolicy({
  name: "test.scanned",
  allowedFiles: [{ contentType: "application/pdf", extensions: ["pdf"] }],
  maxBytes: 4096,
  inspection: UPLOAD_INSPECTION.REQUIRED,
});

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

const token = createFinalizeToken();

function pendingIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: "intent-1",
    objectId: "object-1",
    status: UPLOAD_INTENT_STATUS.PENDING,
    stagingKey: STAGING_KEY,
    finalizeTokenHash: hashFinalizeToken(token),
    policyName: "test.fixture",
    declaredExtension: "pdf",
    expectedContentType: "application/pdf",
    expectedSizeBytes: BigInt(512),
    expectedChecksumSha256: CHECKSUM,
    expiresAt: new Date(NOW.getTime() + 600_000),
    finalizeLeaseTokenHash: null,
    finalizeLeaseExpiresAt: null,
    finalizedAt: null,
    failureReason: null,
    createdAt: NOW,
    version: 1,
    ...overrides,
  };
}

function pendingObject(overrides: Record<string, unknown> = {}) {
  return {
    id: "object-1",
    status: STORAGE_OBJECT_STATUS.PENDING,
    objectKey: FINAL_KEY,
    contentType: null,
    sizeBytes: null,
    checksumSha256: null,
    etag: null,
    inspectionResult: null,
    inspectionReason: null,
    readyAt: null,
    quarantinedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function readyObject() {
  return pendingObject({
    status: STORAGE_OBJECT_STATUS.READY,
    contentType: "application/pdf",
    sizeBytes: BigInt(512),
    checksumSha256: CHECKSUM,
    etag: "final-tag",
    inspectionResult: STORAGE_INSPECTION_RESULT.NOT_CONFIGURED,
    readyAt: NOW,
  });
}

const provider = {
  headObject: vi.fn(),
  computeObjectChecksum: vi.fn(),
  copyObjectConditionally: vi.fn(),
  deleteObject: vi.fn(),
  createPresignedUpload: vi.fn(),
  createPresignedDownload: vi.fn(),
  checkBucket: vi.fn(),
  destroy: vi.fn(),
};

/** The happy path, wired so a test only has to change what it is about. */
function arrangeSuccess() {
  repository.findUploadIntentById.mockResolvedValue(pendingIntent());
  repository.claimUploadIntent.mockResolvedValue(
    pendingIntent({
      status: UPLOAD_INTENT_STATUS.FINALIZING,
      version: 2,
      finalizeLeaseTokenHash: "lease",
      finalizeLeaseExpiresAt: new Date(NOW.getTime() + 30_000),
    }),
  );
  repository.findStorageObjectById.mockResolvedValue(pendingObject());
  repository.completeUploadIntent.mockResolvedValue({
    object: readyObject(),
    intent: pendingIntent({ status: UPLOAD_INTENT_STATUS.FINALIZED }),
  });

  provider.headObject.mockResolvedValue({
    sizeBytes: 512,
    contentType: "application/pdf",
    etag: "staging-tag",
    checksumSha256: CHECKSUM,
  });
  provider.copyObjectConditionally.mockResolvedValue("final-tag");
  provider.deleteObject.mockResolvedValue(undefined);
}

function finalize(overrides: Record<string, unknown> = {}) {
  return finalizeUploadIntent({
    intentId: "intent-1",
    finalizeToken: token,
    policy,
    now: NOW,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getStorageConfiguration.mockReturnValue(configuration);
  getStorageKeyScope.mockReturnValue({
    prefix: "next-fullstack-starter",
    environment: "test",
    testRunId: "run-1",
  });
  requireStorageProvider.mockReturnValue(provider);
});

describe("before anything is claimed", () => {
  it("refuses when storage is disabled", async () => {
    getStorageConfiguration.mockReturnValue({
      ...configuration,
      enabled: false,
    });

    await expect(finalize()).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
  });

  it("answers an unknown intent exactly as it answers a wrong token", async () => {
    repository.findUploadIntentById.mockResolvedValue(null);

    const unknown = (await finalize().catch(
      (error: unknown) => error,
    )) as Error;

    repository.findUploadIntentById.mockResolvedValue(pendingIntent());

    const wrongToken = (await finalize({
      finalizeToken: createFinalizeToken(),
    }).catch((error: unknown) => error)) as Error;

    // A different status or message for the two would let a caller learn which
    // identifiers are real intents.
    expect(unknown.constructor.name).toBe(wrongToken.constructor.name);
    expect(unknown.message).toBe(wrongToken.message);
    expect(repository.claimUploadIntent).not.toHaveBeenCalled();
  });

  it("refuses a policy other than the one that authorized the upload", async () => {
    // Otherwise a caller holding a token could finalize an upload created under
    // a strict policy by presenting a lax one, and `required` inspection would
    // be optional in practice.
    repository.findUploadIntentById.mockResolvedValue(pendingIntent());

    await expect(finalize({ policy: scannedPolicy })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(repository.claimUploadIntent).not.toHaveBeenCalled();
  });

  it("fails closed when the policy requires inspection and none is supplied", async () => {
    repository.findUploadIntentById.mockResolvedValue(
      pendingIntent({ policyName: "test.scanned" }),
    );

    await expect(finalize({ policy: scannedPolicy })).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
    // Checked before the lease is taken, so a deployment with no inspector does
    // not claim, fail, and release every intent under such a policy.
    expect(repository.claimUploadIntent).not.toHaveBeenCalled();
  });

  it("refuses an intent that has already expired", async () => {
    repository.findUploadIntentById.mockResolvedValue(
      pendingIntent({ expiresAt: new Date(NOW.getTime() - 1) }),
    );

    await expect(finalize()).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a terminal intent that is not finalized", async () => {
    for (const status of [
      UPLOAD_INTENT_STATUS.REJECTED,
      UPLOAD_INTENT_STATUS.QUARANTINED,
      UPLOAD_INTENT_STATUS.EXPIRED,
    ]) {
      repository.findUploadIntentById.mockResolvedValue(
        pendingIntent({ status }),
      );

      await expect(finalize()).rejects.toMatchObject({ code: "CONFLICT" });
    }
  });
});

describe("replaying a finalized intent", () => {
  it("returns the same object rather than an error", async () => {
    repository.findUploadIntentById.mockResolvedValue(
      pendingIntent({ status: UPLOAD_INTENT_STATUS.FINALIZED }),
    );
    repository.findStorageObjectById.mockResolvedValue(readyObject());

    await expect(finalize()).resolves.toMatchObject({
      object: { id: "object-1", status: "ready" },
    });
    expect(provider.headObject).not.toHaveBeenCalled();
  });

  it("refuses when the finalized object is not readable", async () => {
    repository.findUploadIntentById.mockResolvedValue(
      pendingIntent({ status: UPLOAD_INTENT_STATUS.FINALIZED }),
    );
    repository.findStorageObjectById.mockResolvedValue(pendingObject());

    await expect(finalize()).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("claiming the lease", () => {
  it("refuses when another attempt already holds a live lease", async () => {
    repository.findUploadIntentById.mockResolvedValue(
      pendingIntent({
        status: UPLOAD_INTENT_STATUS.FINALIZING,
        finalizeLeaseTokenHash: "lease",
        finalizeLeaseExpiresAt: new Date(NOW.getTime() + 10_000),
      }),
    );

    await expect(finalize()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(repository.reclaimUploadIntent).not.toHaveBeenCalled();
  });

  it("takes over a lease that has lapsed", async () => {
    arrangeSuccess();
    repository.findUploadIntentById.mockResolvedValue(
      pendingIntent({
        status: UPLOAD_INTENT_STATUS.FINALIZING,
        finalizeLeaseTokenHash: "lease",
        finalizeLeaseExpiresAt: new Date(NOW.getTime() - 1),
      }),
    );
    repository.reclaimUploadIntent.mockResolvedValue(
      pendingIntent({
        status: UPLOAD_INTENT_STATUS.FINALIZING,
        version: 3,
        finalizeLeaseTokenHash: "new-lease",
        finalizeLeaseExpiresAt: new Date(NOW.getTime() + 30_000),
      }),
    );

    await expect(finalize()).resolves.toMatchObject({
      object: { status: "ready" },
    });
  });

  it("refuses when the claim loses the race", async () => {
    repository.findUploadIntentById.mockResolvedValue(pendingIntent());
    repository.claimUploadIntent.mockResolvedValue(null);

    await expect(finalize()).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("verifying the staged object", () => {
  it("promotes an upload that matches its declaration", async () => {
    arrangeSuccess();

    await expect(finalize()).resolves.toMatchObject({
      object: { id: "object-1", status: "ready", sizeBytes: 512 },
    });

    expect(provider.copyObjectConditionally).toHaveBeenCalledWith({
      sourceKey: STAGING_KEY,
      destinationKey: FINAL_KEY,
      contentType: "application/pdf",
      sourceEtag: "staging-tag",
    });
  });

  it("rejects an upload that never arrived", async () => {
    arrangeSuccess();
    provider.headObject.mockRejectedValue(
      new StorageProviderError(STORAGE_PROVIDER_FAILURE.NOT_FOUND),
    );

    await expect(finalize()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(repository.failUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "missing-upload" }),
    );
  });

  it("rejects bytes of the wrong size", async () => {
    arrangeSuccess();
    provider.headObject.mockResolvedValue({
      sizeBytes: 1024,
      contentType: "application/pdf",
      etag: "staging-tag",
      checksumSha256: CHECKSUM,
    });

    await expect(finalize()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(repository.failUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "size-mismatch" }),
    );
    expect(provider.copyObjectConditionally).not.toHaveBeenCalled();
  });

  it("rejects bytes stored under a different media type", async () => {
    arrangeSuccess();
    provider.headObject.mockResolvedValue({
      sizeBytes: 512,
      contentType: "text/html",
      etag: "staging-tag",
      checksumSha256: CHECKSUM,
    });

    await expect(finalize()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(repository.failUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "content-type-mismatch" }),
    );
  });

  it("streams and hashes the object when the provider stored no checksum", async () => {
    arrangeSuccess();
    provider.headObject.mockResolvedValue({
      sizeBytes: 512,
      contentType: "application/pdf",
      etag: "staging-tag",
      checksumSha256: null,
    });
    provider.computeObjectChecksum.mockResolvedValue(CHECKSUM);

    await expect(finalize()).resolves.toMatchObject({
      object: { status: "ready" },
    });

    expect(provider.computeObjectChecksum).toHaveBeenCalledWith({
      key: STAGING_KEY,
      maxBytes: 512,
    });
  });

  it("rejects a streamed checksum that does not match", async () => {
    arrangeSuccess();
    provider.headObject.mockResolvedValue({
      sizeBytes: 512,
      contentType: "application/pdf",
      etag: "staging-tag",
      checksumSha256: null,
    });
    provider.computeObjectChecksum.mockResolvedValue("b".repeat(64));

    await expect(finalize()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(repository.failUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "checksum-mismatch" }),
    );
  });

  it("rejects an object that overran the declared size while streaming", async () => {
    arrangeSuccess();
    provider.headObject.mockResolvedValue({
      sizeBytes: 512,
      contentType: "application/pdf",
      etag: "staging-tag",
      checksumSha256: null,
    });
    provider.computeObjectChecksum.mockRejectedValue(
      new StorageProviderError(STORAGE_PROVIDER_FAILURE.PRECONDITION_FAILED),
    );

    await expect(finalize()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(repository.failUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "size-mismatch" }),
    );
  });

  it("refuses to promote without an entity tag to make the copy conditional", async () => {
    // An unconditional copy would be a window in which a client could swap the
    // staged bytes between verification and promotion.
    arrangeSuccess();
    provider.headObject.mockResolvedValue({
      sizeBytes: 512,
      contentType: "application/pdf",
      etag: null,
      checksumSha256: CHECKSUM,
    });

    await expect(finalize()).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
    expect(provider.copyObjectConditionally).not.toHaveBeenCalled();
    expect(repository.releaseUploadIntent).toHaveBeenCalled();
  });
});

describe("recovering from a provider failure", () => {
  it("releases the claim when the provider is unreachable before the copy", async () => {
    arrangeSuccess();
    provider.headObject.mockRejectedValue(
      new StorageProviderError(STORAGE_PROVIDER_FAILURE.UNAVAILABLE),
    );

    await expect(finalize()).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });

    // Nothing was written to the bucket, the intent goes back to pending, and
    // the client may retry within its original lifetime.
    expect(repository.releaseUploadIntent).toHaveBeenCalledWith({
      intentId: "intent-1",
      expectedVersion: 2,
      leaseTokenHash: expect.any(String),
    });
    expect(repository.failUploadIntent).not.toHaveBeenCalled();
  });

  it("rejects when the staged bytes changed under the copy", async () => {
    arrangeSuccess();
    provider.copyObjectConditionally.mockRejectedValue(
      new StorageProviderError(STORAGE_PROVIDER_FAILURE.PRECONDITION_FAILED),
    );

    await expect(finalize()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(repository.failUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "checksum-mismatch" }),
    );
  });

  it("does not claim success when the commit lost the lease", async () => {
    arrangeSuccess();
    repository.completeUploadIntent.mockResolvedValue(null);

    await expect(finalize()).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps a completed finalization completed when the staged copy will not delete", async () => {
    // A completed upload is never turned back into a retryable failure because
    // a `DeleteObject` failed; cleanup removes the leftover later.
    arrangeSuccess();
    provider.deleteObject.mockRejectedValue(new Error("delete refused"));

    await expect(finalize()).resolves.toMatchObject({
      object: { status: "ready" },
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.anything(),
      "storage.staging_delete_failed",
    );
  });

  it("rejects when the final object does not match after the copy", async () => {
    arrangeSuccess();
    provider.headObject
      .mockResolvedValueOnce({
        sizeBytes: 512,
        contentType: "application/pdf",
        etag: "staging-tag",
        checksumSha256: CHECKSUM,
      })
      .mockResolvedValueOnce({
        sizeBytes: 8,
        contentType: "application/pdf",
        etag: "final-tag",
        checksumSha256: CHECKSUM,
      });

    await expect(finalize()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(repository.failUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "size-mismatch" }),
    );
  });
});

describe("content inspection", () => {
  it("records not-configured when no inspector is supplied", async () => {
    arrangeSuccess();

    await finalize();

    expect(repository.completeUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        inspection: STORAGE_INSPECTION_RESULT.NOT_CONFIGURED,
      }),
    );
  });

  it("records clean when an inspector says so", async () => {
    arrangeSuccess();

    await finalize({
      inspector: {
        inspect: () => Promise.resolve({ outcome: INSPECTION_OUTCOME.CLEAN }),
      },
    });

    expect(repository.completeUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ inspection: STORAGE_INSPECTION_RESULT.CLEAN }),
    );
  });

  it("tells the inspector only the key, the size, and the declared type", async () => {
    arrangeSuccess();

    const inspect = vi
      .fn()
      .mockResolvedValue({ outcome: INSPECTION_OUTCOME.CLEAN });

    await finalize({ inspector: { inspect } });

    expect(Object.keys(inspect.mock.calls[0]?.[0] as object).sort()).toEqual([
      "declaredContentType",
      "key",
      "objectId",
      "sizeBytes",
    ]);
  });

  it("withholds the object and moves it to quarantine", async () => {
    arrangeSuccess();

    await expect(
      finalize({
        inspector: {
          inspect: () =>
            Promise.resolve({
              outcome: INSPECTION_OUTCOME.QUARANTINE,
              reasonCode: "signature-match",
            }),
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(repository.failUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        intentStatus: UPLOAD_INTENT_STATUS.QUARANTINED,
        objectStatus: STORAGE_OBJECT_STATUS.QUARANTINED,
        reason: "signature-match",
        quarantineKey: expect.stringContaining("/quarantine/"),
      }),
    );
    expect(repository.completeUploadIntent).not.toHaveBeenCalled();
  });

  it("substitutes its own code for a reason it cannot vouch for", async () => {
    arrangeSuccess();

    await finalize({
      inspector: {
        inspect: () =>
          Promise.resolve({
            outcome: INSPECTION_OUTCOME.QUARANTINE,
            reasonCode: "Malware.Win32 found at /var/tmp/x",
          }),
      },
    }).catch(() => undefined);

    expect(repository.failUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "unspecified" }),
    );
  });

  it("releases the attempt and hides what the inspector threw", async () => {
    arrangeSuccess();

    const error = (await finalize({
      inspector: {
        inspect: () =>
          Promise.reject(new Error("clamav socket /var/run/clamd refused")),
      },
    }).catch((thrown: unknown) => thrown)) as Error;

    expect(error).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(error.message).not.toContain("clamav");
    expect(repository.releaseUploadIntent).toHaveBeenCalled();
  });
});

describe("what it logs", () => {
  it("carries only allowed fields on success", async () => {
    arrangeSuccess();

    await finalize();

    const [fields, event] = log.info.mock.calls.at(-1) ?? [];

    expect(event).toBe("storage.upload.finalized");
    expect(Object.keys(fields as object).sort()).toEqual([
      "intentId",
      "objectId",
      "outcome",
      "policyName",
    ]);
  });

  it("never logs a key, a token, or a bucket on any path", async () => {
    arrangeSuccess();
    provider.headObject.mockRejectedValue(
      new StorageProviderError(STORAGE_PROVIDER_FAILURE.UNAVAILABLE),
    );

    await finalize().catch(() => undefined);

    const logged = JSON.stringify([
      log.info.mock.calls,
      log.warn.mock.calls,
      log.error.mock.calls,
    ]);

    expect(logged).not.toContain(STAGING_KEY);
    expect(logged).not.toContain(FINAL_KEY);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain("application-uploads");
  });
});
