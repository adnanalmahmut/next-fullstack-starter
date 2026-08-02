import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StorageObjectStatus, UploadIntentStatus } from "./storage-object";

const getStorageConfiguration = vi.hoisted(() => vi.fn());
const getStorageProvider = vi.hoisted(() => vi.fn());
const repository = vi.hoisted(() => ({
  claimCleanupCandidate: vi.fn(),
  expireStorageObject: vi.fn(),
  findCleanupCandidates: vi.fn(),
}));
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./config", () => ({
  getStorageConfiguration,
  getStorageKeyScope: vi.fn(),
}));
vi.mock("./provider/storage-client.server", () => ({ getStorageProvider }));
vi.mock("./storage-repository.server", () => repository);
vi.mock("@/platform/observability/logger.server", () => ({ logger: log }));

const {
  cleanupExpiredUploadIntents,
  DEFAULT_CLEANUP_LIMIT,
  MAX_CLEANUP_LIMIT,
} = await import("./cleanup-expired-upload-intents.server");
const { STORAGE_OBJECT_STATUS, UPLOAD_INTENT_STATUS } =
  await import("./storage-object");

const NOW = new Date("2026-08-02T12:00:00.000Z");
const STAGING_KEY = "next-fullstack-starter/test/run-1/staging/abcdef01";
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

const deleteObject = vi.fn();

function candidate(
  intentStatus: UploadIntentStatus = UPLOAD_INTENT_STATUS.PENDING,
  objectStatus: StorageObjectStatus = STORAGE_OBJECT_STATUS.PENDING,
  id = "intent-1",
) {
  return {
    intent: {
      id,
      objectId: `object-${id}`,
      status: intentStatus,
      stagingKey: `${STAGING_KEY}-${id}`,
      version: 1,
    },
    object: {
      id: `object-${id}`,
      status: objectStatus,
      objectKey: `${FINAL_KEY}-${id}`,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getStorageConfiguration.mockReturnValue(configuration);
  deleteObject.mockResolvedValue(undefined);
  getStorageProvider.mockReturnValue({ deleteObject });
  repository.findCleanupCandidates.mockResolvedValue([]);
  repository.claimCleanupCandidate.mockResolvedValue(true);
  repository.expireStorageObject.mockResolvedValue(undefined);
});

describe("the batch is bounded", () => {
  it("uses a small default when none is given", async () => {
    await cleanupExpiredUploadIntents();

    expect(repository.findCleanupCandidates).toHaveBeenCalledWith({
      now: expect.any(Date),
      limit: DEFAULT_CLEANUP_LIMIT,
    });
    expect(DEFAULT_CLEANUP_LIMIT).toBeLessThanOrEqual(MAX_CLEANUP_LIMIT);
  });

  it("refuses a batch above the ceiling, or one that is not a positive integer", async () => {
    for (const limit of [0, -1, 1.5, MAX_CLEANUP_LIMIT + 1]) {
      await expect(
        cleanupExpiredUploadIntents({ limit }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }

    expect(repository.findCleanupCandidates).not.toHaveBeenCalled();
  });

  it("refuses when storage is disabled", async () => {
    getStorageConfiguration.mockReturnValue({
      ...configuration,
      enabled: false,
    });

    await expect(cleanupExpiredUploadIntents()).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
    expect(getStorageProvider).not.toHaveBeenCalled();
  });

  it("refuses when the provider cannot be built", async () => {
    getStorageProvider.mockReturnValue(null);

    await expect(cleanupExpiredUploadIntents()).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
  });
});

describe("what a pass removes", () => {
  it("claims the row before it deletes any key", async () => {
    // If the process dies mid-pass, the worst outcome is a key that outlives
    // its row for one more cycle — never a live intent whose staged bytes were
    // removed underneath it.
    const order: string[] = [];

    repository.findCleanupCandidates.mockResolvedValue([candidate()]);
    repository.claimCleanupCandidate.mockImplementation(() => {
      order.push("claim");

      return Promise.resolve(true);
    });
    deleteObject.mockImplementation(() => {
      order.push("delete");

      return Promise.resolve();
    });

    await cleanupExpiredUploadIntents({ now: NOW });

    expect(order[0]).toBe("claim");
  });

  it("removes only the staged key for an intent nobody started", async () => {
    // A pending intent never reached the copy, so visiting the final key would
    // be a wasted round trip.
    repository.findCleanupCandidates.mockResolvedValue([candidate()]);

    const result = await cleanupExpiredUploadIntents({ now: NOW });

    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith(`${STAGING_KEY}-intent-1`);
    expect(result.deletedObjects).toBe(1);
    expect(result.expiredIntents).toBe(1);
  });

  it("also removes the orphan a crashed finalization left at the final key", async () => {
    repository.findCleanupCandidates.mockResolvedValue([
      candidate(UPLOAD_INTENT_STATUS.FINALIZING),
    ]);

    const result = await cleanupExpiredUploadIntents({ now: NOW });

    expect(deleteObject).toHaveBeenCalledWith(`${FINAL_KEY}-intent-1`);
    expect(result.deletedObjects).toBe(2);
  });

  it("leaves the final key alone when the object was already decided", async () => {
    repository.findCleanupCandidates.mockResolvedValue([
      candidate(
        UPLOAD_INTENT_STATUS.FINALIZING,
        STORAGE_OBJECT_STATUS.QUARANTINED,
      ),
    ]);

    await cleanupExpiredUploadIntents({ now: NOW });

    expect(deleteObject).not.toHaveBeenCalledWith(`${FINAL_KEY}-intent-1`);
  });

  it("skips a candidate another pass already claimed", async () => {
    repository.findCleanupCandidates.mockResolvedValue([candidate()]);
    repository.claimCleanupCandidate.mockResolvedValue(false);

    const result = await cleanupExpiredUploadIntents({ now: NOW });

    expect(deleteObject).not.toHaveBeenCalled();
    expect(result.expiredIntents).toBe(0);
    expect(result.examined).toBe(1);
  });

  it("deletes only keys a row named", async () => {
    repository.findCleanupCandidates.mockResolvedValue([
      candidate(UPLOAD_INTENT_STATUS.FINALIZING),
    ]);

    await cleanupExpiredUploadIntents({ now: NOW });

    for (const call of deleteObject.mock.calls) {
      expect([`${STAGING_KEY}-intent-1`, `${FINAL_KEY}-intent-1`]).toContain(
        call[0],
      );
    }
  });
});

describe("when one delete fails", () => {
  it("keeps going through the rest of the batch", async () => {
    repository.findCleanupCandidates.mockResolvedValue([
      candidate(
        UPLOAD_INTENT_STATUS.PENDING,
        STORAGE_OBJECT_STATUS.PENDING,
        "a",
      ),
      candidate(
        UPLOAD_INTENT_STATUS.PENDING,
        STORAGE_OBJECT_STATUS.PENDING,
        "b",
      ),
    ]);
    deleteObject
      .mockRejectedValueOnce(new Error("provider refused"))
      .mockResolvedValueOnce(undefined);

    const result = await cleanupExpiredUploadIntents({ now: NOW });

    expect(result).toMatchObject({
      examined: 2,
      expiredIntents: 2,
      deletedObjects: 1,
      failedDeletes: 1,
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.anything(),
      "storage.cleanup.object_delete_failed",
    );
  });

  it("still expires the object row", async () => {
    repository.findCleanupCandidates.mockResolvedValue([candidate()]);
    deleteObject.mockRejectedValue(new Error("provider refused"));

    await cleanupExpiredUploadIntents({ now: NOW });

    expect(repository.expireStorageObject).toHaveBeenCalledWith(
      "object-intent-1",
    );
  });
});

describe("what it logs", () => {
  it("summarizes the pass with counts and nothing else", async () => {
    repository.findCleanupCandidates.mockResolvedValue([candidate()]);

    await cleanupExpiredUploadIntents({ now: NOW });

    const [fields, event] = log.info.mock.calls.at(-1) ?? [];

    expect(event).toBe("storage.cleanup.completed");
    expect(Object.keys(fields as object).sort()).toEqual([
      "deleted",
      "durationMs",
      "examined",
    ]);
  });

  it("never logs a key", async () => {
    repository.findCleanupCandidates.mockResolvedValue([candidate()]);
    deleteObject.mockRejectedValue(new Error("provider refused"));

    await cleanupExpiredUploadIntents({ now: NOW });

    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls]);

    expect(logged).not.toContain(STAGING_KEY);
    expect(logged).not.toContain(FINAL_KEY);
  });
});
