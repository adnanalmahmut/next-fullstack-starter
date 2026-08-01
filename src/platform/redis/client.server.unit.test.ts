import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StructuredLogger } from "@/platform/observability/create-logger.server";

/**
 * The disabled path, proved without a Redis server.
 *
 * The driver is replaced by a spy rather than stubbed out, because the property
 * worth proving is not "the client works" but "the client is never even
 * created": a disabled Redis must cost nothing, not merely return early.
 */
const createClient = vi.fn();
const logCalls: {
  level: string;
  fields: Record<string, unknown>;
  event: unknown;
}[] = [];

vi.mock("redis", () => ({
  createClient: (options: unknown) => createClient(options) as unknown,
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

const {
  closeRedisClient,
  getRedisClient,
  isRedisEnabled,
  requireRedisClient,
  REDIS_LOG_EVENT,
} = await import("./client.server");
const { resetRedisConfiguration } = await import("./config");

const REDIS_VARIABLES = [
  "REDIS_ENABLED",
  "REDIS_URL",
  "REDIS_KEY_PREFIX",
  "REDIS_CONNECT_TIMEOUT_MS",
  "REDIS_TEST_RUN_ID",
  "REDIS_TEST_WORKER_ID",
] as const;

const savedEnvironment = new Map<string, string | undefined>();

beforeEach(() => {
  createClient.mockReset();
  logCalls.length = 0;
  resetRedisConfiguration();

  for (const name of REDIS_VARIABLES) {
    savedEnvironment.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
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

describe("disabled by default", () => {
  it("reports Redis as disabled with no variable set", () => {
    expect(isRedisEnabled()).toBe(false);
  });

  it("answers null and creates no client", async () => {
    await expect(getRedisClient()).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("fails clearly when a caller requires it", async () => {
    await expect(requireRedisClient()).rejects.toThrow(/not enabled/);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("closes without creating or contacting anything", async () => {
    await expect(closeRedisClient()).resolves.toBeUndefined();
    expect(createClient).not.toHaveBeenCalled();
    expect(logCalls).toEqual([]);
  });

  it("stays disabled when the flag is explicitly false, even with a URL", async () => {
    process.env.REDIS_ENABLED = "false";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    resetRedisConfiguration();

    expect(isRedisEnabled()).toBe(false);
    await expect(getRedisClient()).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("connection failure", () => {
  function stubFailingClient(error: unknown) {
    const client = {
      isOpen: false,
      isReady: false,
      on: vi.fn(),
      connect: vi.fn().mockRejectedValue(error),
      destroy: vi.fn(),
    };

    createClient.mockReturnValue(client);

    return client;
  }

  beforeEach(() => {
    process.env.REDIS_ENABLED = "true";
    process.env.REDIS_URL = "redis://admin:hunter2@cache.internal:6379";
    resetRedisConfiguration();
  });

  it("reports an opaque failure and discards the client", async () => {
    const client = stubFailingClient(
      new Error("connect ECONNREFUSED 10.1.2.3:6379"),
    );

    await expect(requireRedisClient()).rejects.toThrow("Redis is unavailable.");
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it("logs no URL, credential, host, or raw error", async () => {
    stubFailingClient(new Error("connect ECONNREFUSED 10.1.2.3:6379"));

    await expect(getRedisClient()).rejects.toThrow();

    const serialized = JSON.stringify(logCalls);

    for (const forbidden of [
      "hunter2",
      "admin",
      "cache.internal",
      "redis://",
      "ECONNREFUSED",
      "10.1.2.3",
      "stack",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }

    expect(logCalls).toEqual([
      {
        level: "error",
        fields: { errorName: "Error" },
        event: REDIS_LOG_EVENT.CONNECTION_FAILED,
      },
    ]);
  });

  it("does not poison later calls with a cached rejection", async () => {
    stubFailingClient(new Error("unreachable"));

    await expect(getRedisClient()).rejects.toThrow();
    expect(createClient).toHaveBeenCalledOnce();

    const readyClient = {
      isOpen: false,
      isReady: false,
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };

    createClient.mockReturnValue(readyClient);

    await expect(getRedisClient()).resolves.toBe(readyClient);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(readyClient.on).toHaveBeenCalledExactlyOnceWith(
      "error",
      expect.any(Function),
    );

    await closeRedisClient();
  });

  it("shares one connection attempt between concurrent callers", async () => {
    const client = {
      isOpen: false,
      isReady: false,
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };

    createClient.mockReturnValue(client);

    const results = await Promise.all([
      getRedisClient(),
      getRedisClient(),
      getRedisClient(),
    ]);

    expect(results).toEqual([client, client, client]);
    expect(createClient).toHaveBeenCalledOnce();
    expect(client.connect).toHaveBeenCalledOnce();

    await closeRedisClient();
  });

  it("bounds the reconnect policy instead of retrying forever", async () => {
    const client = {
      isOpen: false,
      isReady: false,
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };

    createClient.mockReturnValue(client);

    await getRedisClient();

    const options = createClient.mock.calls[0]?.[0] as {
      socket: {
        connectTimeout: number;
        reconnectStrategy: (retries: number) => number | false;
      };
    };

    expect(options.socket.connectTimeout).toBe(5_000);
    expect(options.socket.reconnectStrategy(0)).toBeGreaterThan(0);
    expect(options.socket.reconnectStrategy(2)).toBeLessThanOrEqual(1_000);
    expect(options.socket.reconnectStrategy(3)).toBe(false);
    expect(options.socket.reconnectStrategy(50)).toBe(false);

    await closeRedisClient();
  });

  it("registers no process signal handler", async () => {
    const before =
      process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");

    const client = {
      isOpen: false,
      isReady: false,
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };

    createClient.mockReturnValue(client);

    await getRedisClient();
    await closeRedisClient();

    expect(
      process.listenerCount("SIGTERM") + process.listenerCount("SIGINT"),
    ).toBe(before);
  });
});
