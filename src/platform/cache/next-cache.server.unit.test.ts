import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheLife = vi.fn();
const cacheTag = vi.fn();

vi.mock("next/cache", () => ({
  cacheLife: (profile: unknown) => cacheLife(profile),
  cacheTag: (tag: unknown) => cacheTag(tag),
}));

const { applyCachePolicy, applyCacheTags, DEFAULT_CACHE_PROFILE } =
  await import("./next-cache.server");
const { createCacheIdentity } = await import("./cache-identity");
const { CACHE_PROFILE, CACHE_PROFILES } = await import("./cache-policy");

const user = createCacheIdentity({
  module: "identity",
  resource: "user",
  version: 1,
  segments: ["user-1"],
});
const users = createCacheIdentity({
  module: "identity",
  resource: "user",
  version: 1,
  segments: [],
});

beforeEach(() => {
  cacheLife.mockReset();
  cacheTag.mockReset();
});

describe("applyCachePolicy", () => {
  it.each(CACHE_PROFILES)("forwards the %s profile by name", (profile) => {
    applyCachePolicy(profile);

    expect(cacheLife).toHaveBeenCalledExactlyOnceWith(profile);
  });

  it("declares the lifetime exactly once per call", () => {
    applyCachePolicy(CACHE_PROFILE.STANDARD, user);

    expect(cacheLife).toHaveBeenCalledOnce();
  });

  it("tags the scope with every identity, in order", () => {
    applyCachePolicy(CACHE_PROFILE.DURABLE, users, user);

    expect(cacheTag.mock.calls).toEqual([
      ["identity:user:v1"],
      ["identity:user:v1:user-1"],
    ]);
  });

  it("applies no tag when none is declared", () => {
    applyCachePolicy(CACHE_PROFILE.FREQUENT);

    expect(cacheTag).not.toHaveBeenCalled();
  });
});

describe("applyCacheTags", () => {
  it("tags without choosing a lifetime", () => {
    applyCacheTags(user);

    expect(cacheTag).toHaveBeenCalledExactlyOnceWith("identity:user:v1:user-1");
    expect(cacheLife).not.toHaveBeenCalled();
  });
});

describe("the default profile", () => {
  it("is the middle one, so an unconsidered choice is not the longest", () => {
    expect(DEFAULT_CACHE_PROFILE).toBe(CACHE_PROFILE.STANDARD);
  });
});
