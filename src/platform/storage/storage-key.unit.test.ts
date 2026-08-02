import { describe, expect, it } from "vitest";

import {
  assertValidStorageKey,
  buildStorageKey,
  isStorageKeyInNamespace,
  isValidStorageKey,
  isValidStorageKeySegment,
  MAX_STORAGE_KEY_LENGTH,
  STORAGE_NAMESPACE,
  STORAGE_NAMESPACES,
  storageNamespacePrefix,
  storageScopePrefix,
  type StorageKeyScope,
} from "./storage-key";

const productionScope: StorageKeyScope = {
  prefix: "next-fullstack-starter",
  environment: "production",
};

const testScope: StorageKeyScope = {
  prefix: "next-fullstack-starter",
  environment: "test",
  testRunId: "run-42",
};

describe("the namespaces", () => {
  it("has exactly three, and staging is the only writable one", () => {
    expect(STORAGE_NAMESPACES).toEqual(["staging", "objects", "quarantine"]);
  });

  it("separates staging from the final and quarantine namespaces", () => {
    const staging = buildStorageKey(testScope, STORAGE_NAMESPACE.STAGING);
    const final = buildStorageKey(testScope, STORAGE_NAMESPACE.OBJECTS);
    const withheld = buildStorageKey(testScope, STORAGE_NAMESPACE.QUARANTINE);

    expect(isStorageKeyInNamespace(staging, STORAGE_NAMESPACE.STAGING)).toBe(
      true,
    );
    expect(isStorageKeyInNamespace(staging, STORAGE_NAMESPACE.OBJECTS)).toBe(
      false,
    );
    expect(isStorageKeyInNamespace(final, STORAGE_NAMESPACE.OBJECTS)).toBe(
      true,
    );
    expect(
      isStorageKeyInNamespace(withheld, STORAGE_NAMESPACE.QUARANTINE),
    ).toBe(true);
  });
});

describe("generated keys", () => {
  it("never repeats", () => {
    const keys = new Set(
      Array.from({ length: 200 }, () =>
        buildStorageKey(testScope, STORAGE_NAMESPACE.OBJECTS),
      ),
    );

    expect(keys.size).toBe(200);
  });

  it("always begins its random segment with an alphanumeric", () => {
    // Base64url would produce a leading `-` or `_` about one time in thirty,
    // and that key would be refused by the segment grammar and by the database
    // — at random, in production, long after the tests that happened not to
    // generate one.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const key = buildStorageKey(testScope, STORAGE_NAMESPACE.STAGING);

      expect(key.split("/").at(-1)).toMatch(/^[0-9a-f]{48}$/);
    }
  });

  it("carries no filename, user, or business identifier", () => {
    const key = buildStorageKey(testScope, STORAGE_NAMESPACE.OBJECTS);

    // There is nothing in the signature to pass one, which is the real
    // guarantee. What is checked here is that the key is only the scope and
    // randomness.
    expect(key.split("/")).toEqual([
      "next-fullstack-starter",
      "test",
      "run-42",
      "objects",
      expect.stringMatching(/^[0-9a-f]{48}$/),
    ]);
  });

  it("puts a test run in its own namespace and leaves it out elsewhere", () => {
    expect(storageScopePrefix(testScope)).toBe(
      "next-fullstack-starter/test/run-42/",
    );
    expect(storageScopePrefix(productionScope)).toBe(
      "next-fullstack-starter/production/",
    );
  });

  it("puts two runs in prefixes neither can reach", () => {
    const other: StorageKeyScope = { ...testScope, testRunId: "run-43" };

    expect(
      buildStorageKey(testScope, STORAGE_NAMESPACE.OBJECTS).startsWith(
        storageScopePrefix(other),
      ),
    ).toBe(false);
  });

  it("refuses a scope segment that could change the path", () => {
    expect(() =>
      storageNamespacePrefix(
        { prefix: "../etc", environment: "test" },
        STORAGE_NAMESPACE.OBJECTS,
      ),
    ).toThrow();
    expect(() =>
      storageScopePrefix({ prefix: "a/b", environment: "test" }),
    ).toThrow();
    expect(() =>
      storageScopePrefix({ prefix: "", environment: "test" }),
    ).toThrow();
  });
});

describe("key validation", () => {
  const valid = `next-fullstack-starter/test/run-42/objects/${"a".repeat(48)}`;

  it("accepts a well-formed key", () => {
    expect(isValidStorageKey(valid)).toBe(true);
    expect(() => assertValidStorageKey(valid)).not.toThrow();
  });

  it("refuses a traversal in any position", () => {
    expect(isValidStorageKey("a/../b/objects/cccccccc")).toBe(false);
    expect(isValidStorageKey("../objects/cccccccc")).toBe(false);
    expect(isValidStorageKey("prefix/..hidden/objects/cccccccc")).toBe(false);
  });

  it("refuses a backslash, an empty segment, or a leading separator", () => {
    expect(isValidStorageKey("prefix\\objects\\cccccccc")).toBe(false);
    expect(isValidStorageKey("prefix//objects/cccccccc")).toBe(false);
    expect(isValidStorageKey("/prefix/objects/cccccccc")).toBe(false);
    expect(isValidStorageKey("prefix/objects/cccccccc/")).toBe(false);
  });

  it("refuses whitespace and control characters", () => {
    expect(isValidStorageKey("prefix/obj ects/cccccccc")).toBe(false);
    expect(isValidStorageKey("prefix/objects/cc\ncccccc")).toBe(false);
  });

  it("bounds the length at both ends", () => {
    expect(isValidStorageKey("short")).toBe(false);
    expect(isValidStorageKey(`a/${"b".repeat(MAX_STORAGE_KEY_LENGTH)}`)).toBe(
      false,
    );
  });

  it("refuses anything that is not a string", () => {
    expect(isValidStorageKey(null)).toBe(false);
    expect(isValidStorageKey(42)).toBe(false);
    expect(isValidStorageKey(undefined)).toBe(false);
  });

  it("throws when asserted on a key it refuses", () => {
    expect(() => assertValidStorageKey("../../etc/passwd")).toThrow();
  });

  it("holds a segment to the same shape", () => {
    expect(isValidStorageKeySegment("run-42")).toBe(true);
    expect(isValidStorageKeySegment("acme.co")).toBe(true);
    expect(isValidStorageKeySegment("-leading")).toBe(false);
    expect(isValidStorageKeySegment("a/b")).toBe(false);
    expect(isValidStorageKeySegment("")).toBe(false);
    expect(isValidStorageKeySegment("a".repeat(65))).toBe(false);
    expect(isValidStorageKeySegment(7)).toBe(false);
  });
});
