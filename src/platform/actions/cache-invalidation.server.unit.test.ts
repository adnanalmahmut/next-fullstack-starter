import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePath = vi.fn();
const revalidateTag = vi.fn();

vi.mock("next/cache", () => ({
  revalidatePath: (path: string, type?: string) => revalidatePath(path, type),
  revalidateTag: (tag: string, profile: unknown) => revalidateTag(tag, profile),
}));

const {
  DEFAULT_REVALIDATE_PROFILE,
  REVALIDATE_PATH_TYPE,
  hasCacheInvalidation,
  runCacheInvalidation,
} = await import("./cache-invalidation.server");

beforeEach(() => {
  revalidatePath.mockReset();
  revalidateTag.mockReset();
});

describe("hasCacheInvalidation", () => {
  it.each([
    { name: "an undefined declaration", invalidation: undefined },
    { name: "an empty declaration", invalidation: {} },
    { name: "empty lists", invalidation: { paths: [], tags: [] } },
  ])("reports nothing to do for $name", ({ invalidation }) => {
    expect(hasCacheInvalidation(invalidation)).toBe(false);
  });

  it.each([
    { name: "a path", invalidation: { paths: [{ path: "/catalog" }] } },
    { name: "a tag", invalidation: { tags: [{ tag: "catalog" }] } },
  ])("reports work for $name", ({ invalidation }) => {
    expect(hasCacheInvalidation(invalidation)).toBe(true);
  });
});

describe("runCacheInvalidation", () => {
  it("does nothing for an absent declaration", () => {
    runCacheInvalidation(undefined);

    expect(revalidatePath).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("invalidates a literal path without a type argument", () => {
    runCacheInvalidation({ paths: [{ path: "/catalog/product-1" }] });

    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith(
      "/catalog/product-1",
      undefined,
    );
  });

  it("passes the type for a dynamic route pattern", () => {
    runCacheInvalidation({
      paths: [{ path: "/catalog/[slug]", type: REVALIDATE_PATH_TYPE.PAGE }],
    });

    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith(
      "/catalog/[slug]",
      REVALIDATE_PATH_TYPE.PAGE,
    );
  });

  it("uses the pinned two-argument tag signature with the default profile", () => {
    runCacheInvalidation({ tags: [{ tag: "catalog" }] });

    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith(
      "catalog",
      DEFAULT_REVALIDATE_PROFILE,
    );
    expect(revalidateTag.mock.calls[0]).toHaveLength(2);
  });

  it("passes an explicit profile through unchanged", () => {
    runCacheInvalidation({
      tags: [{ tag: "catalog", profile: { expire: 0 } }],
    });

    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith("catalog", {
      expire: 0,
    });
  });

  it("applies paths before tags, each in declaration order", () => {
    const order: string[] = [];

    revalidatePath.mockImplementation((path: string) => order.push(path));
    revalidateTag.mockImplementation((tag: string) => order.push(tag));

    runCacheInvalidation({
      paths: [{ path: "/catalog" }, { path: "/catalog/product-1" }],
      tags: [{ tag: "catalog" }, { tag: "catalog-summary" }],
    });

    expect(order).toEqual([
      "/catalog",
      "/catalog/product-1",
      "catalog",
      "catalog-summary",
    ]);
  });

  it("propagates a failure so the caller decides how to record it", () => {
    revalidatePath.mockImplementation(() => {
      throw new Error("Revalidation is unavailable");
    });

    expect(() =>
      runCacheInvalidation({ paths: [{ path: "/catalog" }] }),
    ).toThrow("Revalidation is unavailable");
  });
});
