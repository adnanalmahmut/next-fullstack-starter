import { beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import type { StructuredLogger } from "@/platform/observability/create-logger.server";

/**
 * The cache-aside contract, proved without a Redis server.
 *
 * The Redis platform is replaced by a stub rather than a real client, because
 * the properties worth proving are about *what the cache does when Redis
 * misbehaves* — absent, unreachable, holding a corrupt value, refusing a write —
 * and those are states a healthy server will not produce on demand.
 */
const getRedisClient = vi.fn();
const logCalls: {
  level: string;
  fields: Record<string, unknown>;
  event: unknown;
}[] = [];

vi.mock("@/platform/redis/index.server", async () => {
  const actual = await vi.importActual<
    typeof import("@/platform/redis/index.server")
  >("@/platform/redis/index.server");

  return {
    ...actual,
    getRedisClient: () => getRedisClient() as unknown,
    // A fixed scope, so a key assertion reads as the shape it is meant to prove
    // rather than as whatever the environment happened to produce.
    getRedisKeyScope: () => ({ prefix: "app", environment: "test" }),
  };
});

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

const {
  cacheAside,
  invalidateRedisCache,
  jitteredTtlMs,
  redisCacheKey,
  MAX_CACHE_TTL_MS,
  MAX_CACHE_VALUE_BYTES,
  MIN_CACHE_TTL_MS,
} = await import("./redis-cache-aside.server");
const { createCacheIdentity } = await import("./cache-identity");
const { CACHE_LOG_EVENT } = await import("./log-event");

const identity = createCacheIdentity({
  module: "identity",
  resource: "user",
  version: 1,
  segments: ["user-1"],
});

const schema = z.object({ name: z.string() });
const value = { name: "Ada" };
const KEY = "app:test:cache:identity:user:v1:user-1";
const TTL_MS = 60_000;

function stubClient(overrides: Record<string, unknown> = {}) {
  const client = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    unlink: vi.fn().mockResolvedValue(1),
    ...overrides,
  };

  getRedisClient.mockResolvedValue(client);

  return client;
}

function stored(payload: unknown, version = 1): string {
  return JSON.stringify({ v: version, d: payload });
}

function eventsNamed(event: string) {
  return logCalls.filter((call) => call.event === event);
}

beforeEach(() => {
  getRedisClient.mockReset();
  logCalls.length = 0;
});

describe("keys", () => {
  it("derives the key from the identity and the scope", () => {
    expect(redisCacheKey(identity)).toBe(KEY);
  });
});

describe("Redis is not serving", () => {
  it("loads from the source when Redis is disabled", async () => {
    getRedisClient.mockResolvedValue(null);

    const load = vi.fn().mockResolvedValue(value);

    await expect(
      cacheAside({ identity, schema, ttlMs: TTL_MS, load }),
    ).resolves.toEqual(value);
    expect(load).toHaveBeenCalledOnce();
    expect(eventsNamed(CACHE_LOG_EVENT.BYPASSED)[0]?.fields).toMatchObject({
      outcome: "disabled",
    });
  });

  it("loads from the source when the connection fails", async () => {
    getRedisClient.mockRejectedValue(new Error("Redis is unavailable."));

    const load = vi.fn().mockResolvedValue(value);

    await expect(
      cacheAside({ identity, schema, ttlMs: TTL_MS, load }),
    ).resolves.toEqual(value);
    expect(eventsNamed(CACHE_LOG_EVENT.BYPASSED)[0]?.fields).toMatchObject({
      outcome: "unavailable",
    });
  });

  it("loads from the source when the read fails", async () => {
    const client = stubClient({
      get: vi.fn().mockRejectedValue(new Error("connection reset")),
    });
    const load = vi.fn().mockResolvedValue(value);

    await expect(
      cacheAside({ identity, schema, ttlMs: TTL_MS, load }),
    ).resolves.toEqual(value);
    expect(load).toHaveBeenCalledOnce();
    expect(client.set).not.toHaveBeenCalled();
  });

  it("still answers when the write fails", async () => {
    const client = stubClient({
      set: vi.fn().mockRejectedValue(new Error("read only replica")),
    });

    await expect(
      cacheAside({ identity, schema, ttlMs: TTL_MS, load: () => value }),
    ).resolves.toEqual(value);
    expect(client.set).toHaveBeenCalledOnce();
    expect(eventsNamed(CACHE_LOG_EVENT.WRITE_FAILED)).toHaveLength(1);
  });
});

describe("hits and misses", () => {
  it("returns a stored value without loading", async () => {
    stubClient({ get: vi.fn().mockResolvedValue(stored(value)) });

    const load = vi.fn();

    await expect(
      cacheAside({ identity, schema, ttlMs: TTL_MS, load }),
    ).resolves.toEqual(value);
    expect(load).not.toHaveBeenCalled();
    expect(eventsNamed(CACHE_LOG_EVENT.HIT)).toHaveLength(1);
  });

  it("loads and writes on a miss", async () => {
    const client = stubClient();

    await expect(
      cacheAside({ identity, schema, ttlMs: TTL_MS, load: () => value }),
    ).resolves.toEqual(value);
    expect(client.set).toHaveBeenCalledExactlyOnceWith(KEY, stored(value), {
      expiration: { type: "PX", value: TTL_MS },
    });
  });

  it("records a hit at a level that does not flood the log", () => {
    // A working cache produces one of these per read. At `info` it would be the
    // loudest thing in every request.
    stubClient({ get: vi.fn().mockResolvedValue(stored(value)) });

    return cacheAside({
      identity,
      schema,
      ttlMs: TTL_MS,
      load: () => value,
    }).then(() => {
      expect(eventsNamed(CACHE_LOG_EVENT.HIT)[0]?.level).toBe("debug");
    });
  });
});

describe("null is a value", () => {
  const nullableSchema = z.object({ name: z.string() }).nullable();

  it("stores and returns a cached null", async () => {
    const client = stubClient();
    const load = vi.fn().mockResolvedValue(null);

    await expect(
      cacheAside({ identity, schema: nullableSchema, ttlMs: TTL_MS, load }),
    ).resolves.toBeNull();
    expect(client.set).toHaveBeenCalledExactlyOnceWith(KEY, stored(null), {
      expiration: { type: "PX", value: TTL_MS },
    });
  });

  it("does not confuse a cached null with a missing entry", async () => {
    stubClient({ get: vi.fn().mockResolvedValue(stored(null)) });

    const load = vi.fn();

    await expect(
      cacheAside({ identity, schema: nullableSchema, ttlMs: TTL_MS, load }),
    ).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});

describe("an entry that cannot be trusted", () => {
  it.each([
    { name: "unparseable JSON", raw: "{" },
    { name: "a foreign shape", raw: JSON.stringify({ name: "Ada" }) },
    { name: "an older envelope version", raw: stored(value, 0) },
    { name: "a value the schema refuses", raw: stored({ name: 7 }) },
    { name: "a null envelope", raw: "null" },
  ])("reloads after $name", async ({ raw }) => {
    const client = stubClient({ get: vi.fn().mockResolvedValue(raw) });
    const load = vi.fn().mockResolvedValue(value);

    await expect(
      cacheAside({ identity, schema, ttlMs: TTL_MS, load }),
    ).resolves.toEqual(value);
    expect(load).toHaveBeenCalledOnce();
    expect(client.unlink).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(client.set).toHaveBeenCalledOnce();
  });

  it("still answers when the corrupt entry cannot be removed", async () => {
    stubClient({
      get: vi.fn().mockResolvedValue("{"),
      unlink: vi.fn().mockRejectedValue(new Error("connection reset")),
    });

    await expect(
      cacheAside({ identity, schema, ttlMs: TTL_MS, load: () => value }),
    ).resolves.toEqual(value);
  });
});

describe("the source of truth wins", () => {
  it("propagates a load failure instead of hiding it as a miss", async () => {
    const client = stubClient();
    const failure = new Error("the database is unreachable");

    await expect(
      cacheAside({
        identity,
        schema,
        ttlMs: TTL_MS,
        load: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
    expect(client.set).not.toHaveBeenCalled();
  });

  it("caches nothing after a failed load, so the next call retries", async () => {
    const client = stubClient();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(value);

    await expect(
      cacheAside({ identity, schema, ttlMs: TTL_MS, load }),
    ).rejects.toThrow();
    await expect(
      cacheAside({ identity, schema, ttlMs: TTL_MS, load }),
    ).resolves.toEqual(value);
    expect(load).toHaveBeenCalledTimes(2);
    expect(client.set).toHaveBeenCalledOnce();
  });
});

describe("bounds", () => {
  it.each([MIN_CACHE_TTL_MS - 1, MAX_CACHE_TTL_MS + 1, 0, -1, 1.5, Number.NaN])(
    "refuses the TTL %s",
    async (ttlMs) => {
      stubClient();

      await expect(
        cacheAside({ identity, schema, ttlMs, load: () => value }),
      ).rejects.toThrow(/TTL is not acceptable/);
    },
  );

  it.each([-0.1, 0.6, Number.NaN])(
    "refuses the jitter ratio %s",
    async (jitterRatio) => {
      stubClient();

      await expect(
        cacheAside({
          identity,
          schema,
          ttlMs: TTL_MS,
          jitterRatio,
          load: () => value,
        }),
      ).rejects.toThrow(/jitter ratio is not acceptable/);
    },
  );

  it("refuses the TTL before it touches Redis", async () => {
    await expect(
      cacheAside({ identity, schema, ttlMs: 0, load: () => value }),
    ).rejects.toThrow();
    expect(getRedisClient).not.toHaveBeenCalled();
  });

  it("does not store a value larger than the limit", async () => {
    const client = stubClient();
    const large = { name: "a".repeat(MAX_CACHE_VALUE_BYTES) };

    await expect(
      cacheAside({ identity, schema, ttlMs: TTL_MS, load: () => large }),
    ).resolves.toEqual(large);
    expect(client.set).not.toHaveBeenCalled();
    expect(eventsNamed(CACHE_LOG_EVENT.WRITE_FAILED)[0]?.fields).toMatchObject({
      outcome: "oversized",
    });
  });

  it("does not store a value JSON cannot represent", async () => {
    const client = stubClient();
    const circular: Record<string, unknown> = { name: "Ada" };

    circular.self = circular;

    await expect(
      cacheAside({
        identity,
        schema: z.custom<typeof circular>(() => true),
        ttlMs: TTL_MS,
        load: () => circular,
      }),
    ).resolves.toBe(circular);
    expect(client.set).not.toHaveBeenCalled();
  });
});

describe("TTL jitter", () => {
  it("changes nothing when it is not asked for", () => {
    expect(jitteredTtlMs(TTL_MS, 0)).toBe(TTL_MS);
  });

  it("stays within the ratio it was given", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const jittered = jitteredTtlMs(TTL_MS, 0.25);

      expect(jittered).toBeGreaterThanOrEqual(TTL_MS);
      expect(jittered).toBeLessThanOrEqual(TTL_MS * 1.25);
    }
  });

  it("never pushes a TTL past the ceiling", () => {
    expect(jitteredTtlMs(MAX_CACHE_TTL_MS, 0.5)).toBeLessThanOrEqual(
      MAX_CACHE_TTL_MS,
    );
  });

  it("is applied to the write", async () => {
    const client = stubClient();

    await cacheAside({
      identity,
      schema,
      ttlMs: TTL_MS,
      jitterRatio: 0.5,
      load: () => value,
    });

    const options = client.set.mock.calls[0]?.[2] as {
      expiration: { value: number };
    };

    expect(options.expiration.value).toBeGreaterThanOrEqual(TTL_MS);
    expect(options.expiration.value).toBeLessThanOrEqual(TTL_MS * 1.5);
  });
});

describe("invalidation", () => {
  it("removes exactly the keys it was given", async () => {
    const client = stubClient();
    const other = createCacheIdentity({
      module: "identity",
      resource: "user",
      version: 1,
      segments: ["user-2"],
    });

    await expect(invalidateRedisCache([identity, other])).resolves.toBe(1);
    expect(client.unlink).toHaveBeenCalledExactlyOnceWith([
      KEY,
      "app:test:cache:identity:user:v1:user-2",
    ]);
  });

  it("touches Redis for an empty plan", async () => {
    await expect(invalidateRedisCache([])).resolves.toBe(0);
    expect(getRedisClient).not.toHaveBeenCalled();
  });

  it("reports that it could not delete when Redis is not serving", async () => {
    getRedisClient.mockResolvedValue(null);

    // `null` rather than `0`: "nothing to delete" and "could not delete" are
    // different facts, and a caller that conflated them would report a purge it
    // never performed.
    await expect(invalidateRedisCache([identity])).resolves.toBeNull();
  });
});

describe("secret hygiene", () => {
  it("logs no key, value, or raw error", async () => {
    stubClient({
      get: vi.fn().mockResolvedValue(stored({ name: "Ada Lovelace" })),
    });

    await cacheAside({
      identity: createCacheIdentity({
        module: "identity",
        resource: "user",
        version: 1,
        segments: ["person-at-example-test"],
      }),
      schema,
      ttlMs: TTL_MS,
      load: () => value,
    });

    const serialized = JSON.stringify(logCalls);

    for (const forbidden of [
      "person-at-example-test",
      "Ada Lovelace",
      "app:test:cache",
      "identity:user",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("carries only allowlisted fields", async () => {
    stubClient();

    await cacheAside({ identity, schema, ttlMs: TTL_MS, load: () => value });

    for (const call of logCalls) {
      expect(Object.keys(call.fields).sort()).toEqual(
        expect.arrayContaining(["module", "operation"]),
      );

      for (const field of Object.keys(call.fields)) {
        expect(
          [
            "module",
            "operation",
            "routeName",
            "requestId",
            "durationMs",
            "outcome",
            "errorCode",
            "retryAfterMs",
            "ttlMs",
          ],
          field,
        ).toContain(field);
      }
    }
  });
});
