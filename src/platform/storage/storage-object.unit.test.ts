import { describe, expect, it } from "vitest";

import {
  isTerminalUploadIntentStatus,
  STORAGE_FAILURE_REASONS,
  STORAGE_INSPECTION_RESULT,
  STORAGE_INSPECTION_RESULTS,
  STORAGE_OBJECT_STATUS,
  STORAGE_OBJECT_STATUSES,
  toStorageObjectMetadata,
  UPLOAD_INTENT_STATUS,
  UPLOAD_INTENT_STATUSES,
  type StoredStorageObject,
} from "./storage-object";

const readyObject: StoredStorageObject = {
  id: "object-1",
  status: STORAGE_OBJECT_STATUS.READY,
  objectKey: "prefix/test/objects/abc",
  contentType: "application/pdf",
  sizeBytes: BigInt(2048),
  checksumSha256: "a".repeat(64),
  etag: "an-entity-tag",
  inspectionResult: STORAGE_INSPECTION_RESULT.CLEAN,
  inspectionReason: null,
  readyAt: new Date("2026-08-02T12:00:00.000Z"),
  quarantinedAt: null,
  createdAt: new Date("2026-08-02T11:59:00.000Z"),
};

describe("the closed sets", () => {
  it("names every object status once", () => {
    expect(STORAGE_OBJECT_STATUSES).toEqual([
      "pending",
      "ready",
      "quarantined",
      "rejected",
      "expired",
    ]);
  });

  it("names every intent status once", () => {
    expect(UPLOAD_INTENT_STATUSES).toEqual([
      "pending",
      "finalizing",
      "finalized",
      "quarantined",
      "rejected",
      "expired",
    ]);
  });

  it("keeps not-configured distinct from clean", () => {
    // A file nobody looked at must not be indistinguishable from a file that
    // was looked at and found clean.
    expect(STORAGE_INSPECTION_RESULTS).toEqual([
      "not-configured",
      "clean",
      "quarantined",
    ]);
  });

  it("names failure reasons that carry no detail about the file", () => {
    expect(STORAGE_FAILURE_REASONS).toEqual([
      "missing-upload",
      "size-mismatch",
      "checksum-mismatch",
      "content-type-mismatch",
      "inspection-unavailable",
      "quarantined",
      "expired",
      "abandoned",
    ]);

    for (const reason of STORAGE_FAILURE_REASONS) {
      expect(reason).toMatch(/^[a-z][a-z-]*$/);
    }
  });

  it("treats every state but pending and finalizing as terminal", () => {
    expect(isTerminalUploadIntentStatus(UPLOAD_INTENT_STATUS.PENDING)).toBe(
      false,
    );
    expect(isTerminalUploadIntentStatus(UPLOAD_INTENT_STATUS.FINALIZING)).toBe(
      false,
    );

    for (const status of [
      UPLOAD_INTENT_STATUS.FINALIZED,
      UPLOAD_INTENT_STATUS.QUARANTINED,
      UPLOAD_INTENT_STATUS.REJECTED,
      UPLOAD_INTENT_STATUS.EXPIRED,
    ]) {
      expect(isTerminalUploadIntentStatus(status), status).toBe(true);
    }
  });
});

describe("the metadata a caller receives", () => {
  it("carries what a module needs and nothing about where the bytes are", () => {
    const metadata = toStorageObjectMetadata(readyObject);

    expect(metadata).toEqual({
      id: "object-1",
      status: "ready",
      contentType: "application/pdf",
      sizeBytes: 2048,
      checksumSha256: "a".repeat(64),
      readyAt: "2026-08-02T12:00:00.000Z",
      inspection: "clean",
    });

    const serialized = JSON.stringify(metadata);

    expect(serialized).not.toContain("objects/abc");
    expect(serialized).not.toContain("an-entity-tag");
  });

  it("returns a number rather than a BigInt", () => {
    // A `BigInt` in a DTO is a value that throws the first time anything calls
    // `JSON.stringify` on it.
    const metadata = toStorageObjectMetadata(readyObject);

    expect(typeof metadata?.sizeBytes).toBe("number");
    expect(() => JSON.stringify(metadata)).not.toThrow();
  });

  it("answers null for every state that is not ready", () => {
    for (const status of [
      STORAGE_OBJECT_STATUS.PENDING,
      STORAGE_OBJECT_STATUS.QUARANTINED,
      STORAGE_OBJECT_STATUS.REJECTED,
      STORAGE_OBJECT_STATUS.EXPIRED,
    ]) {
      expect(
        toStorageObjectMetadata({ ...readyObject, status }),
        status,
      ).toBeNull();
    }
  });

  it("answers null for a ready row that is missing verified metadata", () => {
    // Unreachable through the application and refused by the database, so this
    // is the answer for a row that was changed by hand.
    expect(
      toStorageObjectMetadata({ ...readyObject, checksumSha256: null }),
    ).toBeNull();
    expect(
      toStorageObjectMetadata({ ...readyObject, sizeBytes: null }),
    ).toBeNull();
    expect(
      toStorageObjectMetadata({ ...readyObject, contentType: null }),
    ).toBeNull();
    expect(
      toStorageObjectMetadata({ ...readyObject, readyAt: null }),
    ).toBeNull();
    expect(
      toStorageObjectMetadata({ ...readyObject, inspectionResult: null }),
    ).toBeNull();
  });
});
