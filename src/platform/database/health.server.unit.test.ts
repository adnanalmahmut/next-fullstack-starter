import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The PostgreSQL health contract, proved without a database.
 *
 * The shared client is replaced rather than reached, because constructing it
 * would need a reachable server and the properties under test here are about the
 * *mapping*: that a failure becomes a stable code, that nothing from a driver
 * error escapes, that the query is read-only, and that the probe is bounded. The
 * healthy path against a real PostgreSQL belongs to the integration suite, and it
 * is asserted there.
 */
const queryRaw = vi.fn();

vi.mock("./prisma", () => ({
  database: {
    $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) =>
      queryRaw(query, ...values) as Promise<unknown>,
  },
}));

const {
  checkDatabaseHealth,
  DATABASE_HEALTH_STATUS,
  DATABASE_HEALTH_TIMEOUT_MS,
  DATABASE_UNAVAILABLE,
} = await import("./health.server");

beforeEach(() => {
  queryRaw.mockReset();
  queryRaw.mockResolvedValue([{ value: 1 }]);
});

describe("healthy", () => {
  it("reports a latency and nothing else", async () => {
    const health = await checkDatabaseHealth();

    expect(health.status).toBe(DATABASE_HEALTH_STATUS.HEALTHY);
    expect(Object.keys(health).sort()).toEqual(["latencyMs", "status"]);

    if (health.status === DATABASE_HEALTH_STATUS.HEALTHY) {
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(health.latencyMs)).toBe(true);
    }
  });

  it("uses the shared client when none is supplied", async () => {
    await checkDatabaseHealth();

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("accepts an injected probe instead of the shared client", async () => {
    const injected = vi.fn().mockResolvedValue([{ value: 1 }]);

    const health = await checkDatabaseHealth({
      $queryRaw: (query, ...values) =>
        injected(query, ...values) as Promise<unknown>,
    });

    expect(health.status).toBe(DATABASE_HEALTH_STATUS.HEALTHY);
    expect(injected).toHaveBeenCalledTimes(1);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("the query", () => {
  it("is a read-only SELECT with no interpolated value", async () => {
    await checkDatabaseHealth();

    const [template, ...values] = queryRaw.mock.calls[0] ?? [];
    const statement = (template as TemplateStringsArray).join("").trim();

    expect(statement).toBe("SELECT 1");
    expect(values).toEqual([]);
  });

  it("names no table and mutates nothing", async () => {
    await checkDatabaseHealth();

    const [template] = queryRaw.mock.calls[0] ?? [];
    const statement = (template as TemplateStringsArray).join("");

    for (const forbidden of [
      "INSERT",
      "UPDATE",
      "DELETE",
      "DROP",
      "TRUNCATE",
      "CREATE",
      "ALTER",
      "FROM",
      "user",
      "session",
      "pg_",
    ]) {
      expect(statement.toUpperCase(), forbidden).not.toContain(
        forbidden.toUpperCase(),
      );
    }
  });

  it("never uses the unsafe raw query API", async () => {
    // A probe takes no input, so there is nothing a caller could influence — but
    // the safe API is what makes that structural rather than incidental.
    const client = { $queryRaw: vi.fn().mockResolvedValue([]) };

    await checkDatabaseHealth(client);

    expect(client).not.toHaveProperty("$queryRawUnsafe");
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe("unhealthy", () => {
  it.each([
    {
      name: "a refused connection",
      error: new Error(
        "Can't reach database server at db.internal:5432 (postgresql://app:hunter2@db.internal:5432/production)",
      ),
    },
    {
      name: "a failing authentication",
      error: new Error('password authentication failed for user "app"'),
    },
    {
      name: "a driver object rather than an Error",
      error: { code: "P1001", meta: { database_host: "db.internal" } },
    },
  ])("reports a sanitized result for $name", async ({ error }) => {
    queryRaw.mockRejectedValue(error);

    const health = await checkDatabaseHealth();
    const serialized = JSON.stringify(health);

    expect(health).toEqual({
      status: DATABASE_HEALTH_STATUS.UNHEALTHY,
      code: DATABASE_UNAVAILABLE,
    });

    for (const forbidden of [
      "hunter2",
      "db.internal",
      "postgresql://",
      "5432",
      "production",
      "P1001",
      "password",
      "message",
      "stack",
      "meta",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("reports a stable code when the client throws synchronously", async () => {
    queryRaw.mockImplementation(() => {
      throw new Error("the pool is closed");
    });

    await expect(checkDatabaseHealth()).resolves.toEqual({
      status: DATABASE_HEALTH_STATUS.UNHEALTHY,
      code: DATABASE_UNAVAILABLE,
    });
  });

  it("never rejects", async () => {
    queryRaw.mockRejectedValue(new Error("anything at all"));

    await expect(checkDatabaseHealth()).resolves.toBeDefined();
  });
});

describe("bounding", () => {
  it("declares a short, bounded budget", () => {
    expect(DATABASE_HEALTH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DATABASE_HEALTH_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it("answers rather than hanging when the query never settles", async () => {
    queryRaw.mockReturnValue(new Promise(() => undefined));

    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    vi.useFakeTimers();

    try {
      const pending = checkDatabaseHealth();

      await vi.advanceTimersByTimeAsync(DATABASE_HEALTH_TIMEOUT_MS + 1);

      await expect(pending).resolves.toEqual({
        status: DATABASE_HEALTH_STATUS.UNHEALTHY,
        code: DATABASE_UNAVAILABLE,
      });
    } finally {
      vi.useRealTimers();
    }

    // The deadline fired, and the timer it created was still cleared. A probe
    // that runs every few seconds for the life of a deployment must not leave one
    // behind on any path.
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it("clears its timer on the successful path too", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await checkDatabaseHealth();

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    clearTimeoutSpy.mockRestore();
  });
});
