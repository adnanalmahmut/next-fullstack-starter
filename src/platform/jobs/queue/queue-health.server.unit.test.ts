import { beforeEach, describe, expect, it, vi } from "vitest";

const RedisConstructor = vi.hoisted(() => vi.fn());

vi.mock("ioredis", () => ({
  Redis: class {
    constructor(url: string, options: unknown) {
      return RedisConstructor(url, options) as object;
    }
  },
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

const {
  checkJobsQueueHealth,
  JOBS_QUEUE_HEALTH_STATUS,
  JOBS_REDIS_UNAVAILABLE,
} = await import("./queue-health.server");
const { resetJobsConfiguration } = await import("../config/jobs-config");

/**
 * The queue connectivity contract, proved without a Redis server.
 *
 * Two properties matter and neither needs a real queue: a probe must close the
 * connection it opened on every path, and a failure must never carry the address
 * it failed to reach. The healthy path against a real Redis belongs to the jobs
 * integration suite.
 */
const JOBS_VARIABLES = [
  "JOBS_ENABLED",
  "JOBS_REDIS_URL",
  "JOBS_QUEUE_PREFIX",
  "JOBS_TEST_RUN_ID",
] as const;

const saved = new Map<string, string | undefined>();

function enableQueue(): void {
  process.env.JOBS_ENABLED = "true";
  process.env.JOBS_REDIS_URL = "redis://admin:hunter2@queue.internal:6379";
  resetJobsConfiguration();
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue("PONG"),
    quit: vi.fn().mockResolvedValue("OK"),
    disconnect: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  for (const name of JOBS_VARIABLES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }

  resetJobsConfiguration();
  RedisConstructor.mockReturnValue(connection());

  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    saved.clear();
    resetJobsConfiguration();
  };
});

describe("disabled", () => {
  it("answers disabled with no queue configured, and builds no client", async () => {
    await expect(checkJobsQueueHealth()).resolves.toEqual({
      status: JOBS_QUEUE_HEALTH_STATUS.DISABLED,
    });
    expect(RedisConstructor).not.toHaveBeenCalled();
  });

  it("answers disabled when the flag is on but no address is set", async () => {
    process.env.JOBS_ENABLED = "true";
    resetJobsConfiguration();

    await expect(checkJobsQueueHealth()).resolves.toEqual({
      status: JOBS_QUEUE_HEALTH_STATUS.DISABLED,
    });
    expect(RedisConstructor).not.toHaveBeenCalled();
  });

  it("answers disabled when the address is set but the flag is off", async () => {
    process.env.JOBS_REDIS_URL = "redis://127.0.0.1:6379";
    resetJobsConfiguration();

    await expect(checkJobsQueueHealth()).resolves.toEqual({
      status: JOBS_QUEUE_HEALTH_STATUS.DISABLED,
    });
    expect(RedisConstructor).not.toHaveBeenCalled();
  });

  it("carries no latency and no code", async () => {
    const health = await checkJobsQueueHealth();

    expect(Object.keys(health)).toEqual(["status"]);
  });
});

describe("healthy", () => {
  it("connects, pings, and reports a latency", async () => {
    enableQueue();

    const client = connection();

    RedisConstructor.mockReturnValue(client);

    const health = await checkJobsQueueHealth();

    expect(health.status).toBe(JOBS_QUEUE_HEALTH_STATUS.HEALTHY);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.ping).toHaveBeenCalledTimes(1);

    if (health.status === JOBS_QUEUE_HEALTH_STATUS.HEALTHY) {
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("awaits the connection before the command", async () => {
    enableQueue();

    const order: string[] = [];
    const client = connection({
      connect: vi.fn(async () => {
        order.push("connect");
      }),
      ping: vi.fn(async () => {
        order.push("ping");

        return "PONG";
      }),
    });

    RedisConstructor.mockReturnValue(client);

    await checkJobsQueueHealth();

    // A probe wants the connection failure itself, which arrives in milliseconds,
    // rather than a command timing out at the end of the budget.
    expect(order).toEqual(["connect", "ping"]);
  });
});

describe("the probe connection", () => {
  it("retries nothing and buffers nothing", async () => {
    enableQueue();

    await checkJobsQueueHealth();

    const [, options] = RedisConstructor.mock.calls[0] ?? [];
    const settings = options as Record<string, unknown>;

    expect(settings.lazyConnect).toBe(true);
    expect(settings.enableOfflineQueue).toBe(false);
    expect(settings.maxRetriesPerRequest).toBe(1);
    expect((settings.retryStrategy as () => unknown)()).toBeNull();
    expect(settings.connectTimeout).toBeGreaterThan(0);
  });

  it("attaches an error listener, so a failing socket cannot end the process", async () => {
    enableQueue();

    const client = connection();

    RedisConstructor.mockReturnValue(client);

    await checkJobsQueueHealth();

    expect(client.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("builds a fresh connection per probe rather than caching one", async () => {
    enableQueue();

    await checkJobsQueueHealth();
    await checkJobsQueueHealth();

    expect(RedisConstructor).toHaveBeenCalledTimes(2);
  });
});

describe("cleanup", () => {
  it.each([
    { name: "a healthy probe", client: () => connection() },
    {
      name: "a refused connection",
      client: () =>
        connection({
          connect: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
        }),
    },
    {
      name: "a failing ping",
      client: () =>
        connection({ ping: vi.fn().mockRejectedValue(new Error("NOAUTH")) }),
    },
  ])("closes the connection after $name", async ({ client }) => {
    enableQueue();

    const instance = client();

    RedisConstructor.mockReturnValue(instance);

    await checkJobsQueueHealth();

    expect(instance.quit).toHaveBeenCalledTimes(1);
  });

  it("falls back to disconnect when the socket is already gone", async () => {
    enableQueue();

    const instance = connection({
      quit: vi.fn().mockRejectedValue(new Error("Connection is closed.")),
    });

    RedisConstructor.mockReturnValue(instance);

    await checkJobsQueueHealth();

    expect(instance.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("unhealthy", () => {
  it.each([
    {
      name: "a refused connection",
      client: () =>
        connection({
          connect: vi
            .fn()
            .mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:6379")),
        }),
    },
    {
      name: "a rejected authentication",
      client: () =>
        connection({
          ping: vi
            .fn()
            .mockRejectedValue(
              new Error("NOAUTH Authentication required: hunter2"),
            ),
        }),
    },
  ])("reports a sanitized result for $name", async ({ client }) => {
    enableQueue();
    RedisConstructor.mockReturnValue(client());

    const health = await checkJobsQueueHealth();
    const serialized = JSON.stringify(health);

    expect(health).toEqual({
      status: JOBS_QUEUE_HEALTH_STATUS.UNHEALTHY,
      code: JOBS_REDIS_UNAVAILABLE,
    });

    for (const forbidden of [
      "hunter2",
      "admin",
      "queue.internal",
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

  it("bounds a connection that never becomes ready", async () => {
    enableQueue();

    const client = connection({
      connect: vi.fn().mockReturnValue(new Promise(() => undefined)),
    });

    RedisConstructor.mockReturnValue(client);

    vi.useFakeTimers();

    try {
      const pending = checkJobsQueueHealth();

      await vi.advanceTimersByTimeAsync(6_000);

      await expect(pending).resolves.toEqual({
        status: JOBS_QUEUE_HEALTH_STATUS.UNHEALTHY,
        code: JOBS_REDIS_UNAVAILABLE,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    expect(client.quit).toHaveBeenCalledTimes(1);
  });

  it("answers rather than rejecting when the client cannot be constructed", async () => {
    enableQueue();
    RedisConstructor.mockImplementation(() => {
      throw new Error("Invalid URL: redis://admin:hunter2@queue.internal:6379");
    });

    const health = await checkJobsQueueHealth();

    expect(health).toEqual({
      status: JOBS_QUEUE_HEALTH_STATUS.UNHEALTHY,
      code: JOBS_REDIS_UNAVAILABLE,
    });
    expect(JSON.stringify(health)).not.toContain("hunter2");
  });
});

describe("what it never does", () => {
  it("publishes nothing, consumes nothing, and enqueues no probe job", async () => {
    enableQueue();

    const client = connection();

    RedisConstructor.mockReturnValue(client);

    await checkJobsQueueHealth();

    for (const forbidden of ["lpush", "rpush", "xadd", "set", "del", "eval"]) {
      expect(client, forbidden).not.toHaveProperty(forbidden);
    }

    // `PING` and nothing else. A check that added a message to prove the queue
    // works would leave one behind every time it ran.
    expect(client.ping).toHaveBeenCalledWith();
  });
});
