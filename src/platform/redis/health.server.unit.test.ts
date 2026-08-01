import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The health contract, proved without a Redis server.
 *
 * Two properties matter here and neither needs a real server: a disabled Redis
 * must never look unhealthy, and an unhealthy one must never carry a driver
 * message or an address into a result that is likely to be rendered.
 */
const createClient = vi.fn();

vi.mock("redis", () => ({
  createClient: (options: unknown) => createClient(options) as unknown,
}));

vi.mock("@/platform/observability/logger.server", () => {
  const silentLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    child: () => silentLogger,
  };

  return {
    logger: silentLogger,
    createContextLogger: () => silentLogger,
    getRequestLogger: () => silentLogger,
  };
});

const { checkRedisHealth, REDIS_HEALTH_STATUS, REDIS_UNAVAILABLE } =
  await import("./health.server");
const { closeRedisClient } = await import("./client.server");
const { resetRedisConfiguration } = await import("./config");

const REDIS_VARIABLES = [
  "REDIS_ENABLED",
  "REDIS_URL",
  "REDIS_KEY_PREFIX",
  "REDIS_CONNECT_TIMEOUT_MS",
] as const;

const savedEnvironment = new Map<string, string | undefined>();

function enableRedis(): void {
  process.env.REDIS_ENABLED = "true";
  process.env.REDIS_URL = "redis://admin:hunter2@cache.internal:6379";
  process.env.REDIS_CONNECT_TIMEOUT_MS = "200";
  resetRedisConfiguration();
}

beforeEach(() => {
  createClient.mockReset();
  resetRedisConfiguration();

  for (const name of REDIS_VARIABLES) {
    savedEnvironment.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(async () => {
  await closeRedisClient();

  for (const [name, value] of savedEnvironment) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  savedEnvironment.clear();
  resetRedisConfiguration();
});

describe("disabled", () => {
  it("reports disabled without creating a client", async () => {
    await expect(checkRedisHealth()).resolves.toEqual({
      status: REDIS_HEALTH_STATUS.DISABLED,
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("carries no latency and no code", async () => {
    const health = await checkRedisHealth();

    expect(Object.keys(health)).toEqual(["status"]);
  });
});

describe("healthy", () => {
  it("reports a latency after a successful ping", async () => {
    enableRedis();
    createClient.mockReturnValue({
      isOpen: false,
      isReady: false,
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
      ping: vi.fn().mockResolvedValue("PONG"),
    });

    const health = await checkRedisHealth();

    expect(health.status).toBe(REDIS_HEALTH_STATUS.HEALTHY);
    expect(Object.keys(health).sort()).toEqual(["latencyMs", "status"]);

    if (health.status === REDIS_HEALTH_STATUS.HEALTHY) {
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(health.latencyMs)).toBe(true);
    }
  });
});

describe("unhealthy", () => {
  it.each([
    {
      name: "a refused connection",
      client: {
        isOpen: false,
        isReady: false,
        on: vi.fn(),
        connect: vi
          .fn()
          .mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:6379")),
        destroy: vi.fn(),
        ping: vi.fn(),
      },
    },
    {
      name: "a failing ping",
      client: {
        isOpen: false,
        isReady: false,
        on: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn(),
        ping: vi
          .fn()
          .mockRejectedValue(
            new Error("NOAUTH Authentication required: hunter2"),
          ),
      },
    },
    {
      name: "a ping that never answers",
      client: {
        isOpen: false,
        isReady: false,
        on: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn(),
        ping: vi.fn().mockReturnValue(new Promise(() => undefined)),
      },
    },
  ])("reports a sanitized result for $name", async ({ client }) => {
    enableRedis();
    createClient.mockReturnValue(client);

    const health = await checkRedisHealth();
    const serialized = JSON.stringify(health);

    expect(health).toEqual({
      status: REDIS_HEALTH_STATUS.UNHEALTHY,
      code: REDIS_UNAVAILABLE,
    });

    for (const forbidden of [
      "hunter2",
      "admin",
      "cache.internal",
      "redis://",
      "ECONNREFUSED",
      "NOAUTH",
      "10.1.2.3",
      "message",
      "stack",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("bounds a hanging ping by the configured timeout", async () => {
    enableRedis();
    createClient.mockReturnValue({
      isOpen: false,
      isReady: false,
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
      ping: vi.fn().mockReturnValue(new Promise(() => undefined)),
    });

    const startedAt = performance.now();

    await checkRedisHealth();

    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});
