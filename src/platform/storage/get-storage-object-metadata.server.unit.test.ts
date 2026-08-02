import { beforeEach, describe, expect, it, vi } from "vitest";

const findStorageObjectById = vi.hoisted(() => vi.fn());

vi.mock("./storage-repository.server", () => ({ findStorageObjectById }));

const { getStorageObjectMetadata } =
  await import("./get-storage-object-metadata.server");
const { STORAGE_INSPECTION_RESULT, STORAGE_OBJECT_STATUS } =
  await import("./storage-object");

const readyObject = {
  id: "object-1",
  status: STORAGE_OBJECT_STATUS.READY,
  objectKey: "next-fullstack-starter/test/run-1/objects/abcdef01",
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

beforeEach(() => {
  findStorageObjectById.mockReset();
});

describe("reading an object's metadata", () => {
  it("answers from PostgreSQL alone", async () => {
    // Everything a caller needs was verified at finalization and written down
    // then, so asking the bucket again would cost a round trip to learn
    // something already known.
    findStorageObjectById.mockResolvedValue(readyObject);

    await expect(getStorageObjectMetadata("object-1")).resolves.toEqual({
      id: "object-1",
      status: "ready",
      contentType: "application/pdf",
      sizeBytes: 512,
      checksumSha256: "a".repeat(64),
      readyAt: "2026-08-02T12:00:00.000Z",
      inspection: "clean",
    });
  });

  it("never reveals the key or the entity tag", async () => {
    findStorageObjectById.mockResolvedValue(readyObject);

    const serialized = JSON.stringify(
      await getStorageObjectMetadata("object-1"),
    );

    expect(serialized).not.toContain("objects/abcdef01");
    expect(serialized).not.toContain("final-tag");
  });

  it("answers null for an object that does not exist", async () => {
    findStorageObjectById.mockResolvedValue(null);

    await expect(getStorageObjectMetadata("object-1")).resolves.toBeNull();
  });

  it("answers null for every state that is not ready", async () => {
    for (const status of [
      STORAGE_OBJECT_STATUS.PENDING,
      STORAGE_OBJECT_STATUS.QUARANTINED,
      STORAGE_OBJECT_STATUS.REJECTED,
      STORAGE_OBJECT_STATUS.EXPIRED,
    ]) {
      findStorageObjectById.mockResolvedValue({ ...readyObject, status });

      await expect(
        getStorageObjectMetadata("object-1"),
        status,
      ).resolves.toBeNull();
    }
  });
});
