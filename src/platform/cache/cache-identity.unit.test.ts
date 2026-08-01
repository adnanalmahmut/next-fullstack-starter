import { describe, expect, it } from "vitest";

import {
  cacheCollectionIdentity,
  cacheKeySegments,
  cacheTag,
  cacheVersionSegment,
  createCacheIdentity,
  isValidCacheSegment,
  MAX_CACHE_TAG_LENGTH,
  opaqueCacheSegment,
  type CacheIdentity,
} from "./cache-identity";

const detail = createCacheIdentity({
  module: "identity",
  resource: "user",
  version: 1,
  segments: ["user-1"],
});

describe("identity construction", () => {
  it("keeps the parts it was given", () => {
    expect(detail).toEqual({
      module: "identity",
      resource: "user",
      version: 1,
      segments: ["user-1"],
    });
  });

  it("cannot be mutated after it is built", () => {
    // An identity travels into a tag and a key. A caller that could push a
    // segment onto it later would be changing what a stored entry is called.
    expect(Object.isFrozen(detail)).toBe(true);
    expect(Object.isFrozen(detail.segments)).toBe(true);
  });

  it("copies the segments it was handed", () => {
    const segments = ["user-1"];
    const identity = createCacheIdentity({
      module: "identity",
      resource: "user",
      version: 1,
      segments,
    });

    segments.push("user-2");

    expect(identity.segments).toEqual(["user-1"]);
  });

  it.each([
    { name: "an empty module", identity: { module: "", resource: "user" } },
    {
      name: "an uppercase module",
      identity: { module: "Identity", resource: "user" },
    },
    {
      name: "a separator in the module",
      identity: { module: "a:b", resource: "user" },
    },
    {
      name: "a dot in the resource",
      identity: { module: "identity", resource: "a.b" },
    },
    {
      name: "an empty resource",
      identity: { module: "identity", resource: "" },
    },
    {
      name: "an oversized module",
      identity: { module: "a".repeat(33), resource: "user" },
    },
  ])("refuses $name", ({ identity }) => {
    expect(() =>
      createCacheIdentity({ ...identity, version: 1, segments: [] }),
    ).toThrow(/not acceptable/);
  });

  it.each([0, -1, 1.5, 1_000, Number.NaN])(
    "refuses the version %s",
    (version) => {
      expect(() =>
        createCacheIdentity({
          module: "identity",
          resource: "user",
          version,
          segments: [],
        }),
      ).toThrow(/version is not acceptable/);
    },
  );

  it.each([
    { name: "a separator", segment: "a:b" },
    { name: "a wildcard", segment: "user-*" },
    { name: "whitespace", segment: "user 1" },
    { name: "a newline", segment: "user\n1" },
    { name: "an empty segment", segment: "" },
    { name: "an oversized segment", segment: "a".repeat(129) },
  ])("refuses $name", ({ segment }) => {
    expect(() =>
      createCacheIdentity({
        module: "identity",
        resource: "user",
        version: 1,
        segments: [segment],
      }),
    ).toThrow(/segment is not acceptable/);
  });

  it("refuses more segments than a key should carry", () => {
    expect(() =>
      createCacheIdentity({
        module: "identity",
        resource: "user",
        version: 1,
        segments: Array.from({ length: 9 }, (_, index) => `s${index}`),
      }),
    ).toThrow(/too many segments/);
  });

  it("refuses an identity whose tag Next.js would silently drop", () => {
    expect(() =>
      createCacheIdentity({
        module: "identity",
        resource: "user",
        version: 1,
        segments: Array.from({ length: 4 }, () => "a".repeat(120)),
      }),
    ).toThrow(/too long/);
  });

  it.each(["user-1", "user_1", "user.1", "a@b", "AbC123"])(
    "accepts the identifier %s",
    (segment) => {
      expect(isValidCacheSegment(segment)).toBe(true);
    },
  );

  it.each([undefined, null, 1, {}])("refuses the non-string %s", (value) => {
    expect(isValidCacheSegment(value)).toBe(false);
  });
});

describe("tags", () => {
  it("places the version between the resource and the segments", () => {
    expect(cacheTag(detail)).toBe("identity:user:v1:user-1");
  });

  it("makes the collection tag a prefix of every entry tag", () => {
    const collection = cacheCollectionIdentity(detail);

    expect(cacheTag(collection)).toBe("identity:user:v1");
    expect(cacheTag(detail).startsWith(cacheTag(collection))).toBe(true);
  });

  it("separates two versions of the same resource", () => {
    const next = createCacheIdentity({ ...detail, version: 2 });

    expect(cacheTag(next)).toBe("identity:user:v2:user-1");
    expect(cacheTag(next)).not.toBe(cacheTag(detail));
  });

  it("stays inside the length Next.js accepts", () => {
    expect(cacheTag(detail).length).toBeLessThanOrEqual(MAX_CACHE_TAG_LENGTH);
  });

  it("names the version the same way in a tag and in a key", () => {
    expect(cacheVersionSegment(3)).toBe("v3");
    expect(cacheKeySegments(detail)).toEqual([
      "identity",
      "user",
      "v1",
      "user-1",
    ]);
  });
});

describe("opaque segments", () => {
  const email = "person@example.test";

  it("is deterministic, so the same subject reaches the same entry", () => {
    expect(opaqueCacheSegment(email)).toBe(opaqueCacheSegment(email));
  });

  it("discloses nothing about the value", () => {
    const segment = opaqueCacheSegment(email);

    expect(segment).not.toContain("person");
    expect(segment).not.toContain("example");
    expect(segment).toMatch(/^[0-9a-f]{32}$/);
  });

  it("separates two subjects", () => {
    expect(opaqueCacheSegment(email)).not.toBe(
      opaqueCacheSegment("other@example.test"),
    );
  });

  it("produces something a key will accept", () => {
    expect(isValidCacheSegment(opaqueCacheSegment(email))).toBe(true);
  });

  it("refuses an empty value", () => {
    expect(() => opaqueCacheSegment("")).toThrow(/non-empty/);
  });

  it("lets a sensitive value become an identity safely", () => {
    const identity: CacheIdentity = createCacheIdentity({
      module: "identity",
      resource: "user",
      version: 1,
      segments: [opaqueCacheSegment(email)],
    });

    expect(cacheTag(identity)).not.toContain(email);
  });
});
