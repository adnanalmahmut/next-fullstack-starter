import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StructuredLogger } from "@/platform/observability/create-logger.server";

const revalidatePath = vi.fn();
const revalidateTag = vi.fn();
const updateTag = vi.fn();
const invalidateRedisCache = vi.fn();
const logCalls: {
  level: string;
  fields: Record<string, unknown>;
  event: unknown;
}[] = [];

vi.mock("next/cache", () => ({
  revalidatePath: (path: string, type?: string) => revalidatePath(path, type),
  revalidateTag: (tag: string, profile: unknown) => revalidateTag(tag, profile),
  updateTag: (tag: string) => updateTag(tag),
}));

vi.mock("./redis-cache-aside.server", () => ({
  invalidateRedisCache: (identities: unknown) =>
    invalidateRedisCache(identities),
}));

vi.mock("@/platform/observability/logger.server", () => {
  function record(level: string) {
    return (fields: unknown, event: unknown) => {
      logCalls.push({
        level,
        fields: fields as Record<string, unknown>,
        event,
      });
    };
  }

  const recordingLogger = {
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    child: () => recordingLogger,
  } as unknown as StructuredLogger;

  return {
    logger: recordingLogger,
    createContextLogger: () => recordingLogger,
    getRequestLogger: () => recordingLogger,
  };
});

const { runCacheInvalidation } = await import("./cache-invalidation.server");
const {
  assertInvalidationContext,
  hasCacheInvalidation,
  tagStrategyOf,
  INVALIDATION_CONTEXT,
  REVALIDATE_PATH_TYPE,
  TAG_STRATEGY,
} = await import("./cache-invalidation");
const { createCacheIdentity } = await import("./cache-identity");
const { CACHE_LOG_EVENT } = await import("./log-event");

const users = createCacheIdentity({
  module: "identity",
  resource: "user",
  version: 1,
  segments: [],
});
const user = createCacheIdentity({
  module: "identity",
  resource: "user",
  version: 1,
  segments: ["user-1"],
});

beforeEach(() => {
  revalidatePath.mockReset();
  revalidateTag.mockReset();
  updateTag.mockReset();
  invalidateRedisCache.mockReset().mockResolvedValue(1);
  logCalls.length = 0;
});

describe("declaration", () => {
  it.each([
    { name: "nothing", invalidation: undefined, expected: false },
    { name: "an empty plan", invalidation: {}, expected: false },
    {
      name: "a path",
      invalidation: { paths: [{ path: "/a" }] },
      expected: true,
    },
    {
      name: "a tag",
      invalidation: { tags: [{ identity: users }] },
      expected: true,
    },
    { name: "a Redis entry", invalidation: { redis: [user] }, expected: true },
  ])("reports $name", ({ invalidation, expected }) => {
    expect(hasCacheInvalidation(invalidation)).toBe(expected);
  });

  it("defaults a tag to stale-while-revalidate", () => {
    expect(tagStrategyOf({ identity: users })).toBe(
      TAG_STRATEGY.STALE_WHILE_REVALIDATE,
    );
  });

  it("refuses read-your-own-writes outside a Server Action", () => {
    expect(() =>
      assertInvalidationContext(
        {
          tags: [
            { identity: users, strategy: TAG_STRATEGY.READ_YOUR_OWN_WRITES },
          ],
        },
        INVALIDATION_CONTEXT.ROUTE_HANDLER,
      ),
    ).toThrow(/only to a Server Action/);
  });

  it("accepts read-your-own-writes inside a Server Action", () => {
    expect(() =>
      assertInvalidationContext(
        {
          tags: [
            { identity: users, strategy: TAG_STRATEGY.READ_YOUR_OWN_WRITES },
          ],
        },
        INVALIDATION_CONTEXT.SERVER_ACTION,
      ),
    ).not.toThrow();
  });

  it("accepts a stale-while-revalidate tag anywhere", () => {
    expect(() =>
      assertInvalidationContext(
        { tags: [{ identity: users }] },
        INVALIDATION_CONTEXT.ROUTE_HANDLER,
      ),
    ).not.toThrow();
  });
});

describe("running a plan", () => {
  it("does nothing for an absent plan", async () => {
    await expect(
      runCacheInvalidation(undefined, INVALIDATION_CONTEXT.SERVER_ACTION),
    ).resolves.toEqual({ attempted: 0, failed: 0 });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(invalidateRedisCache).not.toHaveBeenCalled();
  });

  it("invalidates a literal path and a dynamic one differently", async () => {
    await runCacheInvalidation(
      {
        paths: [
          { path: "/catalog" },
          { path: "/catalog/[slug]", type: REVALIDATE_PATH_TYPE.PAGE },
        ],
      },
      INVALIDATION_CONTEXT.SERVER_ACTION,
    );

    expect(revalidatePath.mock.calls).toEqual([
      ["/catalog", undefined],
      ["/catalog/[slug]", "page"],
    ]);
  });

  it("marks a tag stale by default", async () => {
    await runCacheInvalidation(
      { tags: [{ identity: users }] },
      INVALIDATION_CONTEXT.ROUTE_HANDLER,
    );

    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith(
      "identity:user:v1",
      "max",
    );
    expect(updateTag).not.toHaveBeenCalled();
  });

  it("honours an explicit profile", async () => {
    await runCacheInvalidation(
      { tags: [{ identity: users, profile: { expire: 30 } }] },
      INVALIDATION_CONTEXT.ROUTE_HANDLER,
    );

    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith("identity:user:v1", {
      expire: 30,
    });
  });

  it("expires a tag immediately for read-your-own-writes", async () => {
    await runCacheInvalidation(
      {
        tags: [{ identity: user, strategy: TAG_STRATEGY.READ_YOUR_OWN_WRITES }],
      },
      INVALIDATION_CONTEXT.SERVER_ACTION,
    );

    expect(updateTag).toHaveBeenCalledExactlyOnceWith(
      "identity:user:v1:user-1",
    );
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("refuses at run time too, if a plan reached a Route Handler anyway", async () => {
    const report = await runCacheInvalidation(
      {
        tags: [{ identity: user, strategy: TAG_STRATEGY.READ_YOUR_OWN_WRITES }],
      },
      INVALIDATION_CONTEXT.ROUTE_HANDLER,
    );

    expect(updateTag).not.toHaveBeenCalled();
    expect(report).toEqual({ attempted: 1, failed: 1 });
  });

  it("deletes the declared Redis entries in one call", async () => {
    await runCacheInvalidation(
      { redis: [user, users] },
      INVALIDATION_CONTEXT.SERVER_ACTION,
    );

    expect(invalidateRedisCache).toHaveBeenCalledExactlyOnceWith([user, users]);
  });

  it("purges Next.js before Redis", async () => {
    const order: string[] = [];

    revalidatePath.mockImplementation(() => order.push("path"));
    revalidateTag.mockImplementation(() => order.push("tag"));
    invalidateRedisCache.mockImplementation(() => {
      order.push("redis");

      return Promise.resolve(1);
    });

    await runCacheInvalidation(
      {
        paths: [{ path: "/catalog" }],
        tags: [{ identity: users }],
        redis: [user],
      },
      INVALIDATION_CONTEXT.SERVER_ACTION,
    );

    expect(order).toEqual(["path", "tag", "redis"]);
  });
});

describe("one failure does not cancel the rest", () => {
  it("attempts every target after the first one throws", async () => {
    revalidatePath.mockImplementationOnce(() => {
      throw new Error("the first path is unavailable");
    });

    const report = await runCacheInvalidation(
      {
        paths: [{ path: "/a" }, { path: "/b" }],
        tags: [{ identity: users }],
        redis: [user],
      },
      INVALIDATION_CONTEXT.SERVER_ACTION,
    );

    expect(revalidatePath).toHaveBeenCalledTimes(2);
    expect(revalidateTag).toHaveBeenCalledOnce();
    expect(invalidateRedisCache).toHaveBeenCalledOnce();
    expect(report).toEqual({ attempted: 4, failed: 1 });
  });

  it("keeps going when Redis is the one that fails", async () => {
    invalidateRedisCache.mockRejectedValue(new Error("connection reset"));

    const report = await runCacheInvalidation(
      { paths: [{ path: "/a" }], redis: [user] },
      INVALIDATION_CONTEXT.SERVER_ACTION,
    );

    expect(revalidatePath).toHaveBeenCalledOnce();
    expect(report).toEqual({ attempted: 2, failed: 1 });
  });

  it("never throws, whatever the plan does", async () => {
    revalidatePath.mockImplementation(() => {
      throw new Error("everything is on fire");
    });
    revalidateTag.mockImplementation(() => {
      throw new Error("everything is still on fire");
    });
    invalidateRedisCache.mockRejectedValue(new Error("and so is Redis"));

    await expect(
      runCacheInvalidation(
        {
          paths: [{ path: "/a" }],
          tags: [{ identity: users }],
          redis: [user],
        },
        INVALIDATION_CONTEXT.SERVER_ACTION,
      ),
    ).resolves.toEqual({ attempted: 3, failed: 3 });
  });

  it("records one failure line per failed target, with a safe code only", async () => {
    revalidatePath.mockImplementation(() => {
      throw new Error("postgres://user:secret@db is unreachable");
    });

    await runCacheInvalidation(
      { paths: [{ path: "/a" }, { path: "/b" }] },
      INVALIDATION_CONTEXT.SERVER_ACTION,
    );

    const failures = logCalls.filter(
      (call) => call.event === CACHE_LOG_EVENT.INVALIDATION_FAILED,
    );

    expect(failures).toHaveLength(2);
    expect(failures[0]?.fields).toEqual({
      module: "cache",
      operation: "cache-invalidation",
      errorCode: "INTERNAL_ERROR",
    });
    expect(JSON.stringify(logCalls)).not.toContain("secret");
  });

  it("records a success line only when nothing failed", async () => {
    await runCacheInvalidation(
      { paths: [{ path: "/a" }] },
      INVALIDATION_CONTEXT.SERVER_ACTION,
    );

    expect(
      logCalls.filter((call) => call.event === CACHE_LOG_EVENT.INVALIDATED),
    ).toHaveLength(1);

    logCalls.length = 0;
    revalidatePath.mockImplementation(() => {
      throw new Error("unavailable");
    });

    await runCacheInvalidation(
      { paths: [{ path: "/a" }] },
      INVALIDATION_CONTEXT.SERVER_ACTION,
    );

    expect(
      logCalls.filter((call) => call.event === CACHE_LOG_EVENT.INVALIDATED),
    ).toHaveLength(0);
  });
});
