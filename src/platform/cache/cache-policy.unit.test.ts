import { describe, expect, it } from "vitest";

import {
  CACHE_PROFILE,
  CACHE_PROFILE_DEFINITIONS,
  CACHE_PROFILES,
  isCacheProfile,
  isValidCacheProfileDefinition,
  REVALIDATE_MAX_PROFILE,
} from "./cache-policy";

describe("the profile set", () => {
  it("is closed and named", () => {
    expect(CACHE_PROFILES).toEqual(["frequent", "standard", "durable"]);
  });

  it("defines every profile it names, and nothing else", () => {
    expect(Object.keys(CACHE_PROFILE_DEFINITIONS).sort()).toEqual(
      [...CACHE_PROFILES].sort(),
    );
  });

  it.each(["frequent", "standard", "durable"])("recognizes %s", (profile) => {
    expect(isCacheProfile(profile)).toBe(true);
  });

  it.each(["Frequent", "seconds", "", "max", 1, null, undefined])(
    "refuses %s",
    (value) => {
      expect(isCacheProfile(value)).toBe(false);
    },
  );
});

describe("the durations", () => {
  it.each(CACHE_PROFILES)("keeps %s internally consistent", (profile) => {
    expect(
      isValidCacheProfileDefinition(CACHE_PROFILE_DEFINITIONS[profile]),
    ).toBe(true);
  });

  it.each(CACHE_PROFILES)("expires %s only after it revalidates", (profile) => {
    const definition = CACHE_PROFILE_DEFINITIONS[profile];

    // The one invariant Next.js itself enforces, asserted here so a new profile
    // fails a test rather than a build.
    expect(definition.expire).toBeGreaterThan(definition.revalidate);
  });

  it("orders the profiles from shortest to longest", () => {
    const [frequent, standard, durable] = [
      CACHE_PROFILE_DEFINITIONS[CACHE_PROFILE.FREQUENT],
      CACHE_PROFILE_DEFINITIONS[CACHE_PROFILE.STANDARD],
      CACHE_PROFILE_DEFINITIONS[CACHE_PROFILE.DURABLE],
    ];

    expect(frequent.revalidate).toBeLessThan(standard.revalidate);
    expect(standard.revalidate).toBeLessThan(durable.revalidate);
    expect(frequent.expire).toBeLessThan(standard.expire);
    expect(standard.expire).toBeLessThan(durable.expire);
  });

  it.each([
    {
      name: "an expiry at the revalidation",
      stale: 30,
      revalidate: 30,
      expire: 30,
    },
    {
      name: "an expiry before the revalidation",
      stale: 30,
      revalidate: 30,
      expire: 10,
    },
    { name: "a zero stale time", stale: 0, revalidate: 30, expire: 60 },
    { name: "a fractional duration", stale: 1.5, revalidate: 30, expire: 60 },
  ])("refuses $name", ({ stale, revalidate, expire }) => {
    expect(isValidCacheProfileDefinition({ stale, revalidate, expire })).toBe(
      false,
    );
  });
});

describe("the revalidation profile", () => {
  it("is the built-in that means stale-while-revalidate", () => {
    // Not one of the application's own profiles: it is the Next.js value that
    // marks a tag stale, and it must never be renamed to look like one.
    expect(REVALIDATE_MAX_PROFILE).toBe("max");
    expect(isCacheProfile(REVALIDATE_MAX_PROFILE)).toBe(false);
  });
});
