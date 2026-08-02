import { describe, expect, it } from "vitest";

import {
  createFinalizeToken,
  createLeaseToken,
  finalizeTokenMatches,
  FINALIZE_TOKEN_LENGTH,
  hashFinalizeToken,
  hashLeaseToken,
  isFinalizeTokenHash,
  isFinalizeTokenShaped,
} from "./finalize-token";

describe("the finalize token", () => {
  it("carries 256 bits and looks nothing like an identifier", () => {
    const token = createFinalizeToken();

    expect(token).toHaveLength(FINALIZE_TOKEN_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Not a UUID, deliberately: a value shaped like one ends up in a URL path
    // or a log line because every other UUID in the system safely does.
    expect(token).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("never repeats", () => {
    const tokens = new Set(
      Array.from({ length: 500 }, () => createFinalizeToken()),
    );

    expect(tokens.size).toBe(500);
  });

  it("hashes to canonical hexadecimal, and the hash is not the token", () => {
    const token = createFinalizeToken();
    const hash = hashFinalizeToken(token);

    expect(isFinalizeTokenHash(hash)).toBe(true);
    expect(hash).not.toContain(token);
    expect(hashFinalizeToken(token)).toBe(hash);
  });

  it("recognizes only a well-shaped token", () => {
    expect(isFinalizeTokenShaped(createFinalizeToken())).toBe(true);
    expect(isFinalizeTokenShaped("a".repeat(42))).toBe(false);
    expect(isFinalizeTokenShaped("a".repeat(44))).toBe(false);
    expect(isFinalizeTokenShaped("a/".repeat(21) + "a")).toBe(false);
    expect(isFinalizeTokenShaped("")).toBe(false);
    expect(isFinalizeTokenShaped(null)).toBe(false);
    expect(isFinalizeTokenShaped(42)).toBe(false);
  });

  it("recognizes only a well-shaped hash", () => {
    expect(isFinalizeTokenHash("a".repeat(64))).toBe(true);
    expect(isFinalizeTokenHash("A".repeat(64))).toBe(false);
    expect(isFinalizeTokenHash("a".repeat(63))).toBe(false);
    expect(isFinalizeTokenHash(undefined)).toBe(false);
  });
});

describe("matching a presented token", () => {
  it("accepts the token it hashed", () => {
    const token = createFinalizeToken();

    expect(finalizeTokenMatches(token, hashFinalizeToken(token))).toBe(true);
  });

  it("refuses a different token", () => {
    const token = createFinalizeToken();

    expect(
      finalizeTokenMatches(createFinalizeToken(), hashFinalizeToken(token)),
    ).toBe(false);
  });

  it("refuses a malformed token without throwing", () => {
    // A throw on "wrong shape" and a rejection on "wrong value" would be
    // distinguishable to a caller, and the whole point is that they must not
    // be.
    const hash = hashFinalizeToken(createFinalizeToken());

    expect(finalizeTokenMatches("", hash)).toBe(false);
    expect(finalizeTokenMatches("too-short", hash)).toBe(false);
    expect(finalizeTokenMatches(null, hash)).toBe(false);
    expect(finalizeTokenMatches({ token: "x" }, hash)).toBe(false);
  });

  it("refuses a stored value that is not a hash", () => {
    const token = createFinalizeToken();

    expect(finalizeTokenMatches(token, token)).toBe(false);
    expect(finalizeTokenMatches(token, "")).toBe(false);
  });
});

describe("the lease token", () => {
  it("is generated the same way and hashed the same way", () => {
    const lease = createLeaseToken();

    expect(lease).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashLeaseToken(lease)).toBe(hashFinalizeToken(lease));
  });

  it("never repeats", () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => createLeaseToken()),
    );

    expect(tokens.size).toBe(200);
  });
});
