import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertCanonicalSha256Hex,
  isCanonicalSha256Hex,
  SHA256_HEX_LENGTH,
  sha256Base64ToHex,
  sha256HexEquals,
  sha256HexToBase64,
} from "./checksum";

const digest = createHash("sha256").update("a file").digest();
const hex = digest.toString("hex");
const base64 = digest.toString("base64");

describe("the canonical form", () => {
  it("accepts 64 lowercase hexadecimal characters", () => {
    expect(isCanonicalSha256Hex(hex)).toBe(true);
    expect(hex).toHaveLength(SHA256_HEX_LENGTH);
  });

  it("refuses uppercase rather than lowercasing it", () => {
    // Normalizing would make the stored value differ from the value the client
    // declared, and a later mismatch would stop meaning anything.
    expect(isCanonicalSha256Hex(hex.toUpperCase())).toBe(false);
  });

  it("refuses the wrong length", () => {
    expect(isCanonicalSha256Hex(hex.slice(0, 63))).toBe(false);
    expect(isCanonicalSha256Hex(`${hex}0`)).toBe(false);
  });

  it("refuses anything that is not a string of hexadecimal digits", () => {
    expect(isCanonicalSha256Hex(`${hex.slice(0, 63)}g`)).toBe(false);
    expect(isCanonicalSha256Hex("")).toBe(false);
    expect(isCanonicalSha256Hex(null)).toBe(false);
    expect(isCanonicalSha256Hex(42)).toBe(false);
    expect(isCanonicalSha256Hex(undefined)).toBe(false);
  });

  it("throws on a value that is not canonical", () => {
    expect(() => assertCanonicalSha256Hex(hex)).not.toThrow();
    expect(() => assertCanonicalSha256Hex("nope")).toThrow();
  });
});

describe("conversion", () => {
  it("round-trips hex through base64", () => {
    expect(sha256HexToBase64(hex)).toBe(base64);
    expect(sha256Base64ToHex(base64)).toBe(hex);
  });

  it("refuses to convert a value that is not canonical hex", () => {
    expect(() => sha256HexToBase64(hex.toUpperCase())).toThrow();
  });

  it("answers null for base64 that is not a SHA-256 digest", () => {
    // A provider may answer with a checksum algorithm this platform did not ask
    // for. That is a case to fall back from, not a crash.
    expect(sha256Base64ToHex("not base64 at all")).toBeNull();
    expect(sha256Base64ToHex(Buffer.alloc(16).toString("base64"))).toBeNull();
    expect(sha256Base64ToHex("")).toBeNull();
  });
});

describe("comparison", () => {
  it("matches a digest against itself", () => {
    expect(sha256HexEquals(hex, hex)).toBe(true);
  });

  it("refuses a different digest of the same length", () => {
    const other = createHash("sha256").update("another file").digest("hex");

    expect(sha256HexEquals(hex, other)).toBe(false);
  });

  it("answers false rather than throwing on a malformed input", () => {
    // Throwing on "wrong shape" and returning false on "wrong value" would be
    // distinguishable, which is the distinction constant-time comparison exists
    // to remove.
    expect(sha256HexEquals("short", hex)).toBe(false);
    expect(sha256HexEquals(hex, "short")).toBe(false);
    expect(sha256HexEquals(hex.toUpperCase(), hex)).toBe(false);
  });
});
