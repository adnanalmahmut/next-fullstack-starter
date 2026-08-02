import { describe, expect, it } from "vitest";

import {
  asAuditMetadata,
  AUDIT_METADATA_REJECTION,
  auditMetadataByteLength,
  checkAuditMetadata,
  FORBIDDEN_AUDIT_METADATA_KEYS,
  isAuditJsonValue,
  MAX_AUDIT_METADATA_BYTES,
} from "./audit-metadata";

describe("isAuditJsonValue", () => {
  it("accepts the values JSON actually has", () => {
    expect(isAuditJsonValue(null)).toBe(true);
    expect(isAuditJsonValue("text")).toBe(true);
    expect(isAuditJsonValue(42)).toBe(true);
    expect(isAuditJsonValue(-1.5)).toBe(true);
    expect(isAuditJsonValue(true)).toBe(true);
    expect(isAuditJsonValue([1, "two", null, { three: 3 }])).toBe(true);
    expect(isAuditJsonValue({ nested: { deeply: [true] } })).toBe(true);
    expect(isAuditJsonValue(Object.create(null) as object)).toBe(true);
  });

  it("refuses the values that only look like JSON", () => {
    // Each of these survives `JSON.stringify` by being changed into something
    // else, which is exactly why serializing is not the test.
    expect(isAuditJsonValue(undefined)).toBe(false);
    expect(isAuditJsonValue(Number.NaN)).toBe(false);
    expect(isAuditJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isAuditJsonValue(BigInt(1))).toBe(false);
    expect(isAuditJsonValue(Symbol("s"))).toBe(false);
    expect(isAuditJsonValue(() => null)).toBe(false);
    expect(isAuditJsonValue(new Date())).toBe(false);
    expect(isAuditJsonValue(new Map())).toBe(false);
    expect(isAuditJsonValue(new Set())).toBe(false);
    expect(isAuditJsonValue(Buffer.from("x"))).toBe(false);
    expect(isAuditJsonValue(new Error("boom"))).toBe(false);
    expect(isAuditJsonValue(/pattern/)).toBe(false);
  });

  it("refuses a class instance even when every field is JSON", () => {
    class Detail {
      readonly scope = "all";
    }

    expect(isAuditJsonValue(new Detail())).toBe(false);
  });

  it("refuses a cycle instead of throwing on it", () => {
    const cyclic: Record<string, unknown> = { scope: "all" };

    cyclic.self = cyclic;

    expect(isAuditJsonValue(cyclic)).toBe(false);
  });

  it("accepts one value appearing twice, which is not a cycle", () => {
    const shared = { scope: "all" };

    expect(isAuditJsonValue({ first: shared, second: shared })).toBe(true);
  });
});

describe("checkAuditMetadata", () => {
  it("accepts an allowlisted shape", () => {
    expect(checkAuditMetadata({ role: "admin" })).toBeNull();
    expect(checkAuditMetadata({ scope: "all" })).toBeNull();
    expect(checkAuditMetadata({})).toBeNull();
  });

  it("requires an object at the top level", () => {
    for (const value of ["text", 1, true, null, ["role"], undefined]) {
      expect(checkAuditMetadata(value)).toBe(AUDIT_METADATA_REJECTION.NOT_JSON);
    }
  });

  it("refuses a raw error, a date, a map, and a buffer", () => {
    expect(checkAuditMetadata({ detail: new Error("boom") })).toBe(
      AUDIT_METADATA_REJECTION.NOT_JSON,
    );
    expect(checkAuditMetadata({ at: new Date() })).toBe(
      AUDIT_METADATA_REJECTION.NOT_JSON,
    );
    expect(checkAuditMetadata({ entries: new Map() })).toBe(
      AUDIT_METADATA_REJECTION.NOT_JSON,
    );
    expect(checkAuditMetadata({ blob: Buffer.from("x") })).toBe(
      AUDIT_METADATA_REJECTION.NOT_JSON,
    );
  });

  it("refuses every forbidden key name, in any case", () => {
    for (const key of FORBIDDEN_AUDIT_METADATA_KEYS) {
      expect(checkAuditMetadata({ [key]: "value" })).toBe(
        AUDIT_METADATA_REJECTION.FORBIDDEN_KEY,
      );
      expect(checkAuditMetadata({ [key.toUpperCase()]: "value" })).toBe(
        AUDIT_METADATA_REJECTION.FORBIDDEN_KEY,
      );
    }
  });

  it("finds a forbidden key nested inside an object or an array", () => {
    expect(checkAuditMetadata({ outer: { inner: { token: "t" } } })).toBe(
      AUDIT_METADATA_REJECTION.FORBIDDEN_KEY,
    );
    expect(
      checkAuditMetadata({ list: [{ ok: 1 }, { email: "a@b.test" }] }),
    ).toBe(AUDIT_METADATA_REJECTION.FORBIDDEN_KEY);
  });

  it("refuses a value that serializes beyond the ceiling", () => {
    const oversized = { note: "x".repeat(MAX_AUDIT_METADATA_BYTES) };

    expect(auditMetadataByteLength(oversized)).toBeGreaterThan(
      MAX_AUDIT_METADATA_BYTES,
    );
    expect(checkAuditMetadata(oversized)).toBe(
      AUDIT_METADATA_REJECTION.TOO_LARGE,
    );
  });

  it("accepts a value that just fits", () => {
    // The envelope is `{"note":"..."}`, which is 11 bytes around the value.
    const fitted = { note: "x".repeat(MAX_AUDIT_METADATA_BYTES - 11) };

    expect(auditMetadataByteLength(fitted)).toBe(MAX_AUDIT_METADATA_BYTES);
    expect(checkAuditMetadata(fitted)).toBeNull();
  });

  it("measures bytes rather than characters", () => {
    expect(auditMetadataByteLength({ role: "مدير" })).toBeGreaterThan(
      JSON.stringify({ role: "مدير" }).length,
    );
  });

  it("refuses a cycle rather than throwing", () => {
    const cyclic: Record<string, unknown> = {};

    cyclic.self = cyclic;

    expect(checkAuditMetadata(cyclic)).toBe(AUDIT_METADATA_REJECTION.NOT_JSON);
  });
});

describe("asAuditMetadata", () => {
  it("narrows an acceptable value and withholds anything else", () => {
    expect(asAuditMetadata({ role: "admin" })).toEqual({ role: "admin" });
    expect(asAuditMetadata({ token: "t" })).toBeNull();
    expect(asAuditMetadata("role=admin")).toBeNull();
  });
});
