import { describe, expect, it } from "vitest";

import { STORAGE_LOG_EVENT } from "./log-event";
import {
  STORAGE_LOG_FIELD_NAMES,
  toStorageLogFields,
} from "./storage-log-fields";

describe("the log allowlist", () => {
  it("names only fields that carry no secret and no address", () => {
    expect([...STORAGE_LOG_FIELD_NAMES]).toEqual([
      "intentId",
      "objectId",
      "policyName",
      "outcome",
      "reasonCode",
      "requestId",
      "errorCode",
      "durationMs",
      "deleted",
      "examined",
    ]);
  });

  it("drops everything outside the allowlist", () => {
    // The line reporting a failure is exactly the line where somebody will want
    // to attach the URL, the key, or the token "so it is not lost". Dropping
    // here rather than at each call site is what makes that impossible.
    const fields = toStorageLogFields({
      intentId: "intent-1",
      objectId: "object-1",
      signedUrl: "https://bucket.example/object?X-Amz-Signature=abc",
      finalizeToken: "a-secret-token",
      bucket: "customer-documents",
      endpoint: "https://s3.example",
      stagingKey: "prefix/test/staging/abc",
      checksumSha256: "a".repeat(64),
      filename: "medical-report.pdf",
      sizeBytes: 1024,
      stack: "Error: at ...",
    } as never);

    expect(fields).toEqual({ intentId: "intent-1", objectId: "object-1" });
  });

  it("omits an absent value rather than serializing null", () => {
    const fields = toStorageLogFields({
      intentId: "intent-1",
      requestId: null,
      policyName: undefined,
    });

    expect(Object.keys(fields)).toEqual(["intentId"]);
  });

  it("keeps every allowed field when it is present", () => {
    const fields = toStorageLogFields({
      intentId: "intent-1",
      objectId: "object-1",
      policyName: "test.fixture",
      outcome: "clean",
      reasonCode: "checksum-mismatch",
      requestId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      errorCode: "DEPENDENCY_UNAVAILABLE",
      durationMs: 12,
      deleted: 2,
      examined: 3,
    });

    expect(Object.keys(fields).sort()).toEqual(
      [...STORAGE_LOG_FIELD_NAMES].sort(),
    );
  });
});

describe("the log events", () => {
  it("names every event under one stable prefix", () => {
    const names = Object.values(STORAGE_LOG_EVENT);

    expect(names).toEqual([
      "storage.upload_intent.created",
      "storage.upload.finalized",
      "storage.upload.rejected",
      "storage.upload.quarantined",
      "storage.provider.unavailable",
      "storage.staging_delete_failed",
      "storage.cleanup.object_delete_failed",
      "storage.cleanup.completed",
    ]);

    for (const name of names) {
      expect(name.startsWith("storage.")).toBe(true);
    }

    expect(new Set(names).size).toBe(names.length);
  });
});
