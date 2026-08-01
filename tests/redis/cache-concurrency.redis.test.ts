import { loadEnvConfig } from "@next/env";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";

loadEnvConfig(process.cwd());

const {
  closeRedisClient,
  getRedisClient,
  getRedisKeyScope,
  requireRedisClient,
} = await import("@/platform/redis/index.server");

const { cacheAside, createCacheIdentity, invalidateRedisCache, redisCacheKey } =
  await import("@/platform/cache/index.server");

const {
  abortIdempotency,
  acquireLock,
  beginIdempotency,
  completeIdempotency,
  consumeRateLimit,
  extendLock,
  idempotencyKeyFor,
  lockKeyFor,
  releaseLock,
  withLock,
  AVAILABILITY_POLICY,
  IDEMPOTENCY_BEGIN_STATUS,
  IDEMPOTENCY_SETTLE_STATUS,
  LOCK_STATUS,
  RATE_LIMIT_STATUS,
  WITH_LOCK_STATUS,
} = await import("@/platform/concurrency/index.server");

const { deleteRedisScope, readRedisScopeKeys } =
  await import("../fixtures/redis.fixture");

/**
 * The cache and concurrency controls against a real server.
 *
 * These are the properties a stub cannot prove: that a counter and its expiry
 * are genuinely atomic under contention, that exactly one of many concurrent
 * callers takes a lock, that an expired lease really does let the next caller
 * in, and that a lease a caller no longer owns really cannot be released by it.
 *
 * The suite is not part of `pnpm verify`. It is reached only through
 * `pnpm test:redis:integration`, which is what keeps a Redis server from
 * becoming a requirement for building or testing the application.
 *
 * Every key lives under this run's own scope, and cleanup scans that scope
 * alone: two runs against one server cannot see or delete each other's data.
 */
function assertRedisTestTarget(): void {
  expect(process.env.APP_ENV).toBe("test");
  expect(process.env.REDIS_ENABLED).toBe("true");

  const url = new URL(process.env.REDIS_URL ?? "redis://invalid.example");

  expect(["redis:", "rediss:"]).toContain(url.protocol);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(url.hostname);
}

const scope = getRedisKeyScope();

/**
 * Waits for a condition, bounded.
 *
 * A fixed `sleep` long enough to be reliable is long enough to make a suite
 * slow, and a short one is flaky. Polling to a deadline is both fast and
 * dependable, and it fails loudly instead of hanging.
 */
async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await condition()) {
      return;
    }

    if (Date.now() >= deadline) {
      expect.unreachable("the condition did not hold before the deadline");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A unique suffix, so two cases in this file cannot collide on a key. */
let counter = 0;

function unique(prefix: string): string {
  counter += 1;

  return `${prefix}-${counter}`;
}

beforeAll(async () => {
  assertRedisTestTarget();

  const client = await requireRedisClient();

  await deleteRedisScope(client, scope);
});

afterEach(async () => {
  const client = await getRedisClient();

  if (client) {
    await deleteRedisScope(client, scope);
  }
});

afterAll(async () => {
  const client = await getRedisClient();

  if (client) {
    const remaining = await readRedisScopeKeys(client, scope);

    expect(remaining).toEqual([]);
  }

  await closeRedisClient();
});

const schema = z.object({ name: z.string(), at: z.number() });

function identityFor(segment: string) {
  return createCacheIdentity({
    module: "identity",
    resource: "user",
    version: 1,
    segments: [segment],
  });
}

describe("cache-aside", () => {
  it("writes a value with a TTL and reads it back", async () => {
    const identity = identityFor(unique("write"));
    const value = { name: "Ada", at: 1 };

    await expect(
      cacheAside({ identity, schema, ttlMs: 60_000, load: () => value }),
    ).resolves.toEqual(value);

    const client = await requireRedisClient();
    const ttl = await client.pTTL(redisCacheKey(identity));

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it("serves the second read from the cache without loading again", async () => {
    const identity = identityFor(unique("hit"));
    let loads = 0;
    const load = () => {
      loads += 1;

      return { name: "Ada", at: loads };
    };

    await expect(
      cacheAside({ identity, schema, ttlMs: 60_000, load }),
    ).resolves.toEqual({ name: "Ada", at: 1 });
    await expect(
      cacheAside({ identity, schema, ttlMs: 60_000, load }),
    ).resolves.toEqual({ name: "Ada", at: 1 });

    expect(loads).toBe(1);
  });

  it("reloads once the entry has expired", async () => {
    const identity = identityFor(unique("expiry"));
    let loads = 0;
    const load = () => {
      loads += 1;

      return { name: "Ada", at: loads };
    };

    await cacheAside({ identity, schema, ttlMs: 1_000, load });

    const client = await requireRedisClient();

    await waitUntil(
      async () => (await client.exists(redisCacheKey(identity))) === 0,
      4_000,
    );

    await expect(
      cacheAside({ identity, schema, ttlMs: 60_000, load }),
    ).resolves.toEqual({ name: "Ada", at: 2 });
  });

  it("reloads and repairs an entry that cannot be decoded", async () => {
    const identity = identityFor(unique("corrupt"));
    const client = await requireRedisClient();

    await client.set(redisCacheKey(identity), "not json at all");

    await expect(
      cacheAside({
        identity,
        schema,
        ttlMs: 60_000,
        load: () => ({ name: "Ada", at: 1 }),
      }),
    ).resolves.toEqual({ name: "Ada", at: 1 });

    // The repaired entry is a real one, decodable on the next read.
    await expect(
      cacheAside({
        identity,
        schema,
        ttlMs: 60_000,
        load: () => expect.unreachable("the repaired entry should be a hit"),
      }),
    ).resolves.toEqual({ name: "Ada", at: 1 });
  });

  it("removes exactly the entry it is told to", async () => {
    const kept = identityFor(unique("kept"));
    const purged = identityFor(unique("purged"));
    const value = { name: "Ada", at: 1 };

    await cacheAside({
      identity: kept,
      schema,
      ttlMs: 60_000,
      load: () => value,
    });
    await cacheAside({
      identity: purged,
      schema,
      ttlMs: 60_000,
      load: () => value,
    });

    await expect(invalidateRedisCache([purged])).resolves.toBe(1);

    const client = await requireRedisClient();

    expect(await client.exists(redisCacheKey(purged))).toBe(0);
    expect(await client.exists(redisCacheKey(kept))).toBe(1);
  });

  it("stores a null distinguishably from a missing entry", async () => {
    const identity = identityFor(unique("null"));
    const nullable = schema.nullable();
    let loads = 0;

    const load = () => {
      loads += 1;

      return null;
    };

    await expect(
      cacheAside({ identity, schema: nullable, ttlMs: 60_000, load }),
    ).resolves.toBeNull();
    await expect(
      cacheAside({ identity, schema: nullable, ttlMs: 60_000, load }),
    ).resolves.toBeNull();

    expect(loads).toBe(1);
  });
});

describe("rate limiting", () => {
  it("allows exactly the limit and refuses the next request", async () => {
    const identity = { name: "probe.rate-limit", subject: unique("subject") };
    const options = { identity, limit: 3, windowMs: 5_000 };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await consumeRateLimit(options);

      expect(result).toMatchObject({
        status: RATE_LIMIT_STATUS.ALLOWED,
        remaining: 3 - attempt,
      });
    }

    expect(await consumeRateLimit(options)).toMatchObject({
      status: RATE_LIMIT_STATUS.LIMITED,
      remaining: 0,
    });
  });

  it("gives the counter an expiry, so the window really resets", async () => {
    const identity = { name: "probe.rate-limit", subject: unique("expiry") };

    await consumeRateLimit({ identity, limit: 1, windowMs: 1_000 });

    const client = await requireRedisClient();
    const keys = await readRedisScopeKeys(client, scope);
    const [key] = keys.filter((candidate) => candidate.includes("rate-limit"));

    expect(key).toBeDefined();
    expect(await client.pTTL(key as string)).toBeGreaterThan(0);

    await waitUntil(
      async () => (await client.exists(key as string)) === 0,
      4_000,
    );

    expect(
      await consumeRateLimit({ identity, limit: 1, windowMs: 1_000 }),
    ).toMatchObject({ status: RATE_LIMIT_STATUS.ALLOWED });
  });

  it("counts every concurrent request exactly once", async () => {
    const identity = { name: "probe.rate-limit", subject: unique("parallel") };
    const options = { identity, limit: 20, windowMs: 10_000 };

    const results = await Promise.all(
      Array.from({ length: 40 }, () => consumeRateLimit(options)),
    );

    const allowed = results.filter(
      (result) => result.status === RATE_LIMIT_STATUS.ALLOWED,
    );
    const limited = results.filter(
      (result) => result.status === RATE_LIMIT_STATUS.LIMITED,
    );

    // Not "roughly twenty": the increment and the expiry are one script, so the
    // count is exact even when forty callers arrive together.
    expect(allowed).toHaveLength(20);
    expect(limited).toHaveLength(20);
  });

  it("keeps the expiry when a second caller increments an existing counter", async () => {
    const identity = {
      name: "probe.rate-limit",
      subject: unique("expiry-keep"),
    };
    const options = { identity, limit: 10, windowMs: 5_000 };

    await consumeRateLimit(options);

    const client = await requireRedisClient();
    const [key] = (await readRedisScopeKeys(client, scope)).filter(
      (candidate) => candidate.includes("rate-limit"),
    );
    const first = await client.pTTL(key as string);

    await consumeRateLimit(options);

    const second = await client.pTTL(key as string);

    // A second `PEXPIRE` would restart the window and let a caller extend its
    // own budget indefinitely by keeping the counter warm.
    expect(second).toBeLessThanOrEqual(first);
  });

  it("charges the declared cost", async () => {
    const identity = { name: "probe.rate-limit", subject: unique("cost") };
    const options = { identity, limit: 10, windowMs: 5_000, cost: 4 };

    expect(await consumeRateLimit(options)).toMatchObject({ remaining: 6 });
    expect(await consumeRateLimit(options)).toMatchObject({ remaining: 2 });
    expect(await consumeRateLimit(options)).toMatchObject({
      status: RATE_LIMIT_STATUS.LIMITED,
    });
  });
});

describe("idempotency", () => {
  const outputSchema = z.object({ id: z.string() });
  const fingerprint = "0123456789abcdef0123456789abcdef";

  function scopeFor(key: string) {
    return {
      routeName: "probe.idempotency",
      apiVersion: "v1",
      subject: "user-1",
      idempotencyKey: key,
    };
  }

  it("lets exactly one concurrent attempt claim the key", async () => {
    const target = scopeFor(unique("concurrent-key"));

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        beginIdempotency({ scope: target, fingerprint, outputSchema }),
      ),
    );

    expect(
      results.filter(
        (result) => result.status === IDEMPOTENCY_BEGIN_STATUS.ACQUIRED,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) => result.status === IDEMPOTENCY_BEGIN_STATUS.CONFLICT,
      ),
    ).toHaveLength(9);
  });

  it("replays a completed attempt for the same request", async () => {
    const target = scopeFor(unique("replay-key"));
    const begun = await beginIdempotency({
      scope: target,
      fingerprint,
      outputSchema,
    });

    if (begun.status !== IDEMPOTENCY_BEGIN_STATUS.ACQUIRED) {
      expect.unreachable("the first attempt should claim the key");
    }

    await expect(
      completeIdempotency(begun.handle, fingerprint, { id: "entity-1" }),
    ).resolves.toBe(IDEMPOTENCY_SETTLE_STATUS.SETTLED);

    await expect(
      beginIdempotency({ scope: target, fingerprint, outputSchema }),
    ).resolves.toEqual({
      status: IDEMPOTENCY_BEGIN_STATUS.REPLAY,
      output: { id: "entity-1" },
    });
  });

  it("conflicts when the same key carries a different request", async () => {
    const target = scopeFor(unique("mismatch-key"));
    const begun = await beginIdempotency({
      scope: target,
      fingerprint,
      outputSchema,
    });

    if (begun.status !== IDEMPOTENCY_BEGIN_STATUS.ACQUIRED) {
      expect.unreachable("the first attempt should claim the key");
    }

    await completeIdempotency(begun.handle, fingerprint, { id: "entity-1" });

    await expect(
      beginIdempotency({
        scope: target,
        fingerprint: "ffffffffffffffffffffffffffffffff",
        outputSchema,
      }),
    ).resolves.toEqual({ status: IDEMPOTENCY_BEGIN_STATUS.CONFLICT });
  });

  it("lets a retry through after an abort", async () => {
    const target = scopeFor(unique("abort-key"));
    const begun = await beginIdempotency({
      scope: target,
      fingerprint,
      outputSchema,
    });

    if (begun.status !== IDEMPOTENCY_BEGIN_STATUS.ACQUIRED) {
      expect.unreachable("the first attempt should claim the key");
    }

    await expect(abortIdempotency(begun.handle)).resolves.toBe(
      IDEMPOTENCY_SETTLE_STATUS.SETTLED,
    );

    const retry = await beginIdempotency({
      scope: target,
      fingerprint,
      outputSchema,
    });

    expect(retry.status).toBe(IDEMPOTENCY_BEGIN_STATUS.ACQUIRED);
  });

  it("recovers on its own once a stalled attempt's TTL expires", async () => {
    const target = scopeFor(unique("ttl-key"));

    // This is the crash window made observable: a process that died between the
    // commit and the completion leaves a claim behind, and only the TTL releases
    // it. A retry inside the window is refused; a retry after it is allowed.
    const begun = await beginIdempotency({
      scope: target,
      fingerprint,
      outputSchema,
      processingTtlMs: 1_000,
    });

    expect(begun.status).toBe(IDEMPOTENCY_BEGIN_STATUS.ACQUIRED);
    await expect(
      beginIdempotency({ scope: target, fingerprint, outputSchema }),
    ).resolves.toEqual({ status: IDEMPOTENCY_BEGIN_STATUS.CONFLICT });

    const client = await requireRedisClient();

    await waitUntil(
      async () => (await client.exists(idempotencyKeyFor(target))) === 0,
      4_000,
    );

    await expect(
      beginIdempotency({ scope: target, fingerprint, outputSchema }),
    ).resolves.toMatchObject({ status: IDEMPOTENCY_BEGIN_STATUS.ACQUIRED });
  });

  it("lets only the owning attempt publish a result", async () => {
    const target = scopeFor(unique("owner-key"));
    const begun = await beginIdempotency({
      scope: target,
      fingerprint,
      outputSchema,
    });

    if (begun.status !== IDEMPOTENCY_BEGIN_STATUS.ACQUIRED) {
      expect.unreachable("the first attempt should claim the key");
    }

    const impostor = { ...begun.handle, owner: "not-the-owner" };

    await expect(
      completeIdempotency(impostor, fingerprint, { id: "forged" }),
    ).resolves.toBe(IDEMPOTENCY_SETTLE_STATUS.LOST);
    await expect(abortIdempotency(impostor)).resolves.toBe(
      IDEMPOTENCY_SETTLE_STATUS.LOST,
    );

    // The real owner is unaffected by the attempt to overwrite it.
    await expect(
      completeIdempotency(begun.handle, fingerprint, { id: "entity-1" }),
    ).resolves.toBe(IDEMPOTENCY_SETTLE_STATUS.SETTLED);
  });

  it("expires a completed record on its own TTL", async () => {
    const target = scopeFor(unique("completed-ttl"));
    const begun = await beginIdempotency({
      scope: target,
      fingerprint,
      outputSchema,
      completedTtlMs: 1_000,
    });

    if (begun.status !== IDEMPOTENCY_BEGIN_STATUS.ACQUIRED) {
      expect.unreachable("the first attempt should claim the key");
    }

    await completeIdempotency(begun.handle, fingerprint, { id: "entity-1" });

    const client = await requireRedisClient();

    await waitUntil(
      async () => (await client.exists(idempotencyKeyFor(target))) === 0,
      4_000,
    );

    // Past the retention window the operation is performed again rather than
    // replayed — which is exactly why a non-repeatable operation needs a durable
    // record in PostgreSQL instead.
    await expect(
      beginIdempotency({ scope: target, fingerprint, outputSchema }),
    ).resolves.toMatchObject({ status: IDEMPOTENCY_BEGIN_STATUS.ACQUIRED });
  });
});

describe("locks", () => {
  it("gives the lock to exactly one of many contenders", async () => {
    const identity = { name: "probe.lock", segments: [unique("contended")] };

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        acquireLock({ identity, leaseMs: 5_000 }),
      ),
    );

    expect(
      results.filter((result) => result.status === LOCK_STATUS.ACQUIRED),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === LOCK_STATUS.CONTENDED),
    ).toHaveLength(9);
  });

  it("refuses a release from anyone but the owner", async () => {
    const identity = { name: "probe.lock", segments: [unique("owner")] };
    const acquisition = await acquireLock({ identity, leaseMs: 5_000 });

    if (acquisition.status !== LOCK_STATUS.ACQUIRED) {
      expect.unreachable("the lock should have been acquired");
    }

    await expect(
      releaseLock({ ...acquisition.handle, token: "not-the-owner" }),
    ).resolves.toBe(false);

    const client = await requireRedisClient();

    expect(await client.exists(lockKeyFor(identity))).toBe(1);
    await expect(releaseLock(acquisition.handle)).resolves.toBe(true);
  });

  it("lets the next caller in once the lock is released", async () => {
    const identity = { name: "probe.lock", segments: [unique("handover")] };
    const first = await acquireLock({ identity, leaseMs: 5_000 });

    if (first.status !== LOCK_STATUS.ACQUIRED) {
      expect.unreachable("the lock should have been acquired");
    }

    await expect(
      acquireLock({ identity, leaseMs: 5_000 }),
    ).resolves.toMatchObject({ status: LOCK_STATUS.CONTENDED });
    await releaseLock(first.handle);
    await expect(
      acquireLock({ identity, leaseMs: 5_000 }),
    ).resolves.toMatchObject({ status: LOCK_STATUS.ACQUIRED });
  });

  it("lets the next caller in once the lease expires", async () => {
    const identity = { name: "probe.lock", segments: [unique("lease")] };
    const first = await acquireLock({ identity, leaseMs: 500 });

    if (first.status !== LOCK_STATUS.ACQUIRED) {
      expect.unreachable("the lock should have been acquired");
    }

    const client = await requireRedisClient();

    await waitUntil(
      async () => (await client.exists(lockKeyFor(identity))) === 0,
      4_000,
    );

    const second = await acquireLock({ identity, leaseMs: 5_000 });

    expect(second.status).toBe(LOCK_STATUS.ACQUIRED);

    if (second.status !== LOCK_STATUS.ACQUIRED) {
      return;
    }

    // The dangerous case: the first owner comes back after its lease expired and
    // must not be able to release the lease that now belongs to somebody else.
    await expect(releaseLock(first.handle)).resolves.toBe(false);
    expect(await client.exists(lockKeyFor(identity))).toBe(1);
    await expect(releaseLock(second.handle)).resolves.toBe(true);
  });

  it("extends a lease only for its owner", async () => {
    const identity = { name: "probe.lock", segments: [unique("extend")] };
    const acquisition = await acquireLock({ identity, leaseMs: 1_000 });

    if (acquisition.status !== LOCK_STATUS.ACQUIRED) {
      expect.unreachable("the lock should have been acquired");
    }

    await expect(
      extendLock({ ...acquisition.handle, token: "not-the-owner" }, 10_000),
    ).resolves.toBe(false);
    await expect(extendLock(acquisition.handle, 10_000)).resolves.toBe(true);

    const client = await requireRedisClient();

    expect(await client.pTTL(lockKeyFor(identity))).toBeGreaterThan(1_000);
    await releaseLock(acquisition.handle);
  });

  it("waits for a busy lock and gives up at its deadline", async () => {
    const identity = { name: "probe.lock", segments: [unique("timeout")] };
    const holder = await acquireLock({ identity, leaseMs: 5_000 });

    if (holder.status !== LOCK_STATUS.ACQUIRED) {
      expect.unreachable("the lock should have been acquired");
    }

    const startedAt = Date.now();
    const waited = await acquireLock({
      identity,
      leaseMs: 5_000,
      waitTimeoutMs: 300,
      retryDelayMs: 20,
    });

    expect(waited.status).toBe(LOCK_STATUS.TIMEOUT);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    await releaseLock(holder.handle);
  });

  it("releases the lock even when the callback throws", async () => {
    const identity = { name: "probe.lock", segments: [unique("with-lock")] };
    const failure = new Error("the work failed");

    await expect(
      withLock(
        { identity, leaseMs: 5_000, policy: AVAILABILITY_POLICY.REQUIRED },
        () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    const client = await requireRedisClient();

    expect(await client.exists(lockKeyFor(identity))).toBe(0);
  });

  it("runs a callback under the lock and reports contention to the next caller", async () => {
    const identity = { name: "probe.lock", segments: [unique("serial")] };
    let inside = 0;
    let observedMax = 0;

    async function work() {
      inside += 1;
      observedMax = Math.max(observedMax, inside);
      await new Promise((resolve) => setTimeout(resolve, 50));
      inside -= 1;

      return "done";
    }

    const [first, second] = await Promise.all([
      withLock(
        { identity, leaseMs: 5_000, policy: AVAILABILITY_POLICY.REQUIRED },
        work,
      ),
      withLock(
        { identity, leaseMs: 5_000, policy: AVAILABILITY_POLICY.REQUIRED },
        work,
      ),
    ]);

    const statuses = [first?.status, second?.status].sort();

    expect(statuses).toEqual([
      WITH_LOCK_STATUS.CONTENDED,
      WITH_LOCK_STATUS.EXECUTED,
    ]);
    expect(observedMax).toBe(1);
  });
});

describe("key discipline", () => {
  it("writes every key under this run's scope and nowhere else", async () => {
    const identity = identityFor(unique("scoped"));

    await cacheAside({
      identity,
      schema,
      ttlMs: 60_000,
      load: () => ({ name: "Ada", at: 1 }),
    });
    await consumeRateLimit({
      identity: { name: "probe.rate-limit", subject: unique("scoped") },
      limit: 5,
      windowMs: 5_000,
    });
    await beginIdempotency({
      scope: {
        routeName: "probe.idempotency",
        apiVersion: "v1",
        subject: "user-1",
        idempotencyKey: unique("scoped-idempotency-key"),
      },
      fingerprint: "0123456789abcdef0123456789abcdef",
      outputSchema: z.object({ id: z.string() }),
    });
    await acquireLock({
      identity: { name: "probe.lock", segments: [unique("scoped")] },
      leaseMs: 5_000,
    });

    const client = await requireRedisClient();
    const keys = await readRedisScopeKeys(client, scope);
    const namespaces = new Set(
      keys.map((key) => key.slice(scope.prefix.length + 1)),
    );

    expect(keys.length).toBeGreaterThanOrEqual(4);

    for (const key of keys) {
      expect(key.startsWith(scope.prefix), key).toBe(true);
    }

    expect([...namespaces].some((suffix) => suffix.includes(":cache:"))).toBe(
      true,
    );
    expect(
      [...namespaces].some((suffix) => suffix.includes(":rate-limit:")),
    ).toBe(true);
    expect(
      [...namespaces].some((suffix) => suffix.includes(":idempotency:")),
    ).toBe(true);
    expect([...namespaces].some((suffix) => suffix.includes(":lock:"))).toBe(
      true,
    );
  });

  it("puts no readable subject in any key it writes", async () => {
    const email = "person@example.test";

    await consumeRateLimit({
      identity: { name: "probe.rate-limit", subject: email },
      limit: 5,
      windowMs: 5_000,
    });
    await beginIdempotency({
      scope: {
        routeName: "probe.idempotency",
        apiVersion: "v1",
        subject: email,
        idempotencyKey: unique("hidden-subject-key"),
      },
      fingerprint: "0123456789abcdef0123456789abcdef",
      outputSchema: z.object({ id: z.string() }),
    });

    const client = await requireRedisClient();
    const keys = await readRedisScopeKeys(client, scope);

    for (const key of keys) {
      expect(key, key).not.toContain("person");
      expect(key, key).not.toContain("example.test");
    }
  });
});
