import { loadEnvConfig } from "@next/env";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

loadEnvConfig(process.cwd());

const {
  buildRedisKey,
  checkRedisHealth,
  closeRedisClient,
  getRedisClient,
  getRedisConfiguration,
  getRedisKeyScope,
  isRedisEnabled,
  redisNamespacePattern,
  redisScopePrefix,
  REDIS_HEALTH_STATUS,
  REDIS_NAMESPACE,
  REDIS_UNAVAILABLE,
  requireRedisClient,
  resetRedisConfiguration,
} = await import("@/platform/redis/index.server");

const { deleteRedisScope, readRedisScopeKeys } =
  await import("../fixtures/redis.fixture");

/**
 * The Redis foundation against a real server.
 *
 * This suite is not part of `pnpm verify`. It is reached only through
 * `pnpm test:redis:integration`, which is what keeps a Redis server from
 * becoming a requirement for building or testing the application.
 *
 * Every key it writes lives under this run's own scope, and cleanup scans that
 * scope alone: two runs against one server, including two CI runs, cannot see
 * or delete each other's data.
 */
function assertRedisTestTarget() {
  expect(process.env.APP_ENV).toBe("test");
  expect(process.env.REDIS_ENABLED).toBe("true");

  const url = new URL(process.env.REDIS_URL ?? "redis://invalid.example");

  expect(["redis:", "rediss:"]).toContain(url.protocol);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(url.hostname);
}

const scope = getRedisKeyScope();

beforeAll(async () => {
  assertRedisTestTarget();

  const client = await requireRedisClient();

  await deleteRedisScope(client, scope);
});

afterAll(async () => {
  const client = await getRedisClient();

  if (client) {
    await deleteRedisScope(client, scope);
  }

  await closeRedisClient();
});

beforeEach(async () => {
  const client = await requireRedisClient();

  await deleteRedisScope(client, scope);
});

describe("configuration", () => {
  it("is enabled for this suite", () => {
    expect(isRedisEnabled()).toBe(true);
    expect(getRedisConfiguration().enabled).toBe(true);
  });

  it("scopes this run's keys to a unique prefix", () => {
    expect(scope.environment).toBe("test");
    expect(scope.testRunId).toBeDefined();
    expect(redisScopePrefix(scope)).toContain(":test:");
  });
});

describe("connection", () => {
  it("connects and answers a ping", async () => {
    const client = await requireRedisClient();

    await expect(client.ping()).resolves.toBe("PONG");
  });

  it("returns the same client to every caller", async () => {
    const [first, second] = await Promise.all([
      requireRedisClient(),
      requireRedisClient(),
    ]);

    expect(first).toBe(second);
    expect(await getRedisClient()).toBe(first);
  });

  it("shares one connection between concurrent first callers", async () => {
    await closeRedisClient();

    const clients = await Promise.all(
      Array.from({ length: 8 }, () => requireRedisClient()),
    );

    expect(new Set(clients).size).toBe(1);
    await expect(clients[0]?.ping()).resolves.toBe("PONG");
  });

  it("reuses the singleton across a module reload", async () => {
    const client = await requireRedisClient();

    // A development reload re-evaluates the module. Clearing the module
    // registry reproduces that: the client lives on `globalThis`, so the
    // freshly evaluated copy must find the open connection rather than opening
    // a second one and leaking the first.
    vi.resetModules();

    const reloaded = await import("@/platform/redis/client.server");

    expect(reloaded.getRedisClient).not.toBe(getRedisClient);
    await expect(reloaded.getRedisClient()).resolves.toBe(client);
    await expect(client.ping()).resolves.toBe("PONG");
  });

  it("closes and reconnects", async () => {
    const first = await requireRedisClient();

    await closeRedisClient();

    expect(first.isOpen).toBe(false);

    const second = await requireRedisClient();

    expect(second).not.toBe(first);
    await expect(second.ping()).resolves.toBe("PONG");
  });

  it("closes idempotently", async () => {
    await requireRedisClient();
    await closeRedisClient();

    await expect(closeRedisClient()).resolves.toBeUndefined();
  });
});

describe("commands", () => {
  it("sets, reads, and deletes a scoped key", async () => {
    const client = await requireRedisClient();
    const key = buildRedisKey(scope, REDIS_NAMESPACE.CACHE, "user", "user-1");

    await expect(client.get(key)).resolves.toBeNull();
    await client.set(key, "value-1");
    await expect(client.get(key)).resolves.toBe("value-1");
    await expect(client.del(key)).resolves.toBe(1);
    await expect(client.get(key)).resolves.toBeNull();
  });

  it("honours an expiry", async () => {
    const client = await requireRedisClient();
    const key = buildRedisKey(scope, REDIS_NAMESPACE.TEMPORARY, "token", "t-1");

    await client.set(key, "value", { expiration: { type: "EX", value: 60 } });

    const ttl = await client.ttl(key);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("keeps namespaces apart", async () => {
    const client = await requireRedisClient();
    const cacheKey = buildRedisKey(scope, REDIS_NAMESPACE.CACHE, "subject");
    const lockKey = buildRedisKey(scope, REDIS_NAMESPACE.LOCK, "subject");

    await client.set(cacheKey, "cached");
    await client.set(lockKey, "locked");

    expect(cacheKey).not.toBe(lockKey);
    await expect(client.get(cacheKey)).resolves.toBe("cached");
    await expect(client.get(lockKey)).resolves.toBe("locked");
  });
});

describe("health", () => {
  it("reports healthy with a latency", async () => {
    const health = await checkRedisHealth();

    expect(health.status).toBe(REDIS_HEALTH_STATUS.HEALTHY);

    if (health.status === REDIS_HEALTH_STATUS.HEALTHY) {
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("reports unhealthy for an unreachable server without leaking the address", async () => {
    const savedUrl = process.env.REDIS_URL;

    await closeRedisClient();
    // A port nothing listens on, with credentials in the URL, so the result can
    // be checked for both a failure and a leak.
    process.env.REDIS_URL = "redis://admin:hunter2@127.0.0.1:6399";
    process.env.REDIS_CONNECT_TIMEOUT_MS = "300";
    resetRedisConfiguration();

    try {
      const health = await checkRedisHealth();
      const serialized = JSON.stringify(health);

      expect(health).toEqual({
        status: REDIS_HEALTH_STATUS.UNHEALTHY,
        code: REDIS_UNAVAILABLE,
      });

      for (const forbidden of ["hunter2", "admin", "6399", "redis://"]) {
        expect(serialized, forbidden).not.toContain(forbidden);
      }
    } finally {
      await closeRedisClient();

      if (savedUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = savedUrl;
      }

      delete process.env.REDIS_CONNECT_TIMEOUT_MS;
      resetRedisConfiguration();
    }
  });

  it("reports disabled without touching the server", async () => {
    await closeRedisClient();
    process.env.REDIS_ENABLED = "false";
    resetRedisConfiguration();

    try {
      await expect(checkRedisHealth()).resolves.toEqual({
        status: REDIS_HEALTH_STATUS.DISABLED,
      });
      await expect(getRedisClient()).resolves.toBeNull();
    } finally {
      process.env.REDIS_ENABLED = "true";
      resetRedisConfiguration();
    }
  });
});

describe("test isolation", () => {
  it("writes every key under this run's scope", async () => {
    const client = await requireRedisClient();
    const prefix = redisScopePrefix(scope);

    await client.set(buildRedisKey(scope, REDIS_NAMESPACE.CACHE, "a"), "1");
    await client.set(buildRedisKey(scope, REDIS_NAMESPACE.LOCK, "b"), "2");

    const keys = await readRedisScopeKeys(client, scope);

    expect(keys).toHaveLength(2);

    for (const key of keys) {
      expect(key.startsWith(`${prefix}:`), key).toBe(true);
    }
  });

  it("cannot see or delete another run's keys", async () => {
    const client = await requireRedisClient();
    const otherScope = { ...scope, testRunId: "run-foreign" };
    const otherKey = buildRedisKey(otherScope, REDIS_NAMESPACE.CACHE, "theirs");
    const ownKey = buildRedisKey(scope, REDIS_NAMESPACE.CACHE, "ours");

    await client.set(otherKey, "theirs");
    await client.set(ownKey, "ours");

    try {
      expect(await readRedisScopeKeys(client, scope)).toEqual([ownKey]);

      const deleted = await deleteRedisScope(client, scope);

      expect(deleted).toBe(1);
      await expect(client.get(otherKey)).resolves.toBe("theirs");
      await expect(client.get(ownKey)).resolves.toBeNull();
    } finally {
      await client.unlink(otherKey);
    }
  });

  it("cleans up with SCAN and UNLINK across many keys", async () => {
    const client = await requireRedisClient();
    const keys = Array.from({ length: 250 }, (_, index) =>
      buildRedisKey(scope, REDIS_NAMESPACE.CACHE, `entry-${index}`),
    );

    await Promise.all(keys.map((key) => client.set(key, "value")));

    expect(await readRedisScopeKeys(client, scope)).toHaveLength(250);
    expect(await deleteRedisScope(client, scope)).toBe(250);
    expect(await readRedisScopeKeys(client, scope)).toEqual([]);
  });

  it("bounds a namespace scan to the namespace", async () => {
    const client = await requireRedisClient();

    await client.set(buildRedisKey(scope, REDIS_NAMESPACE.CACHE, "a"), "1");
    await client.set(buildRedisKey(scope, REDIS_NAMESPACE.LOCK, "b"), "2");

    const pattern = redisNamespacePattern(scope, REDIS_NAMESPACE.CACHE);
    const found = await client.scan("0", { MATCH: pattern, COUNT: 100 });

    expect(found.keys).toEqual([
      buildRedisKey(scope, REDIS_NAMESPACE.CACHE, "a"),
    ]);
  });

  it("leaves the surrounding key space untouched", async () => {
    const client = await requireRedisClient();
    const outsideKey = "unrelated-tenant:production:cache:keep-me";

    await client.set(outsideKey, "keep");

    try {
      await client.set(buildRedisKey(scope, REDIS_NAMESPACE.CACHE, "own"), "1");
      await deleteRedisScope(client, scope);

      await expect(client.get(outsideKey)).resolves.toBe("keep");
    } finally {
      await client.unlink(outsideKey);
    }
  });
});
