import { describe, expect, it } from "vitest";

import {
  isAuditRequestId,
  isAuditResourceId,
  isCanonicalUuid,
  MAX_AUDIT_RESOURCE_ID_LENGTH,
} from "./audit-identifier";

describe("isCanonicalUuid", () => {
  it("accepts a canonical UUID in either case and any version", () => {
    expect(isCanonicalUuid("3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe(true);
    expect(isCanonicalUuid("3F2504E0-4F89-41D3-9A0C-0305E82C3301")).toBe(true);
    // uuid7, which is what the record identifiers are.
    expect(isCanonicalUuid("0198f0e0-1111-7222-8333-444455556666")).toBe(true);
  });

  it("refuses anything else", () => {
    for (const value of [
      "",
      "3f2504e04f8941d39a0c0305e82c3301",
      "3f2504e0-4f89-41d3-9a0c-0305e82c330",
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301x",
      "zzzzzzzz-4f89-41d3-9a0c-0305e82c3301",
      undefined,
      null,
      1,
    ]) {
      expect(isCanonicalUuid(value), String(value)).toBe(false);
    }
  });
});

describe("isAuditRequestId", () => {
  it("accepts a canonical request identifier", () => {
    expect(isAuditRequestId("3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe(true);
  });

  it("refuses an arbitrary client string", () => {
    expect(isAuditRequestId("req-1")).toBe(false);
    expect(isAuditRequestId("../../etc/passwd")).toBe(false);
  });
});

describe("isAuditResourceId", () => {
  it("accepts a bounded, trimmed identifier", () => {
    expect(isAuditResourceId("target-1")).toBe(true);
    expect(isAuditResourceId("x".repeat(MAX_AUDIT_RESOURCE_ID_LENGTH))).toBe(
      true,
    );
  });

  it("refuses an empty, padded, or oversized identifier", () => {
    expect(isAuditResourceId("")).toBe(false);
    expect(isAuditResourceId(" target-1 ")).toBe(false);
    expect(
      isAuditResourceId("x".repeat(MAX_AUDIT_RESOURCE_ID_LENGTH + 1)),
    ).toBe(false);
    expect(isAuditResourceId(42)).toBe(false);
  });
});
