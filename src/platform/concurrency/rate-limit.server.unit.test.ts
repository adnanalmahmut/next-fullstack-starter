import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StructuredLogger } from "@/platform/observability/create-logger.server";

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
  consumeRateLimit,
  MAX_RATE_LIMIT,
  MAX_RATE_LIMIT_WINDOW_MS,
  MIN_RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_STATUS,
} = await import("./rate-limit.server");
const { opaqueKeySegment } = await import("@/platform/redis/index.server");
const { CONCURRENCY_LOG_EVENT } = await import("./log-event");

const identity = { name: "identity.admin.users.list", subject: "203.0.113.7" };
const options = { identity, limit: 5, windowMs: 60_000 };

function stubEval(reply: unknown) {
  const evaluate = vi.fn().mockResolvedValue(reply);

  getRedisClient.mockResolvedValue({ eval: evaluate });

  return evaluate;
}

beforeEach(() => {
  getRedisClient.mockReset();
  logCalls.length = 0;
});

describe("Redis is not serving", () => {
  it("answers disabled without pretending to have counted", async () => {
    getRedisClient.mockResolvedValue(null);

    await expect(consumeRateLimit(options)).resolves.toEqual({
      status: RATE_LIMIT_STATUS.DISABLED,
    });
  });

  it("answers unavailable when the connection fails", async () => {
    getRedisClient.mockRejectedValue(new Error("Redis is unavailable."));

    await expect(consumeRateLimit(options)).resolves.toEqual({
      status: RATE_LIMIT_STATUS.UNAVAILABLE,
    });
  });

  it("answers unavailable when the script fails", async () => {
    getRedisClient.mockResolvedValue({
      eval: vi.fn().mockRejectedValue(new Error("NOSCRIPT")),
    });

    await expect(consumeRateLimit(options)).resolves.toEqual({
      status: RATE_LIMIT_STATUS.UNAVAILABLE,
    });
  });

  it.each([
    { name: "a reply that is not a pair", reply: "OK" },
    { name: "a short reply", reply: [1] },
    { name: "a non-numeric count", reply: ["many", 100] },
  ])("answers unavailable for $name", async ({ reply }) => {
    // A limiter that read a malformed reply as zero would be a limiter that
    // silently stopped limiting.
    stubEval(reply);

    await expect(consumeRateLimit(options)).resolves.toEqual({
      status: RATE_LIMIT_STATUS.UNAVAILABLE,
    });
  });

  it("records the reason it could not count", async () => {
    getRedisClient.mockResolvedValue(null);

    await consumeRateLimit(options);

    expect(logCalls).toEqual([
      {
        level: "warn",
        fields: {
          module: "concurrency",
          operation: "rate-limit",
          outcome: "disabled",
        },
        event: CONCURRENCY_LOG_EVENT.RATE_LIMIT_UNAVAILABLE,
      },
    ]);
  });
});

describe("counting", () => {
  it("allows a request inside the window and reports what is left", async () => {
    stubEval([2, 45_000]);

    const result = await consumeRateLimit(options);

    expect(result).toMatchObject({
      status: RATE_LIMIT_STATUS.ALLOWED,
      limit: 5,
      remaining: 3,
    });
  });

  it("allows the request that reaches the limit exactly", async () => {
    stubEval([5, 1_000]);

    expect(await consumeRateLimit(options)).toMatchObject({
      status: RATE_LIMIT_STATUS.ALLOWED,
      remaining: 0,
    });
  });

  it("refuses the one after it, and says when to return", async () => {
    stubEval([6, 12_000]);

    expect(await consumeRateLimit(options)).toMatchObject({
      status: RATE_LIMIT_STATUS.LIMITED,
      limit: 5,
      remaining: 0,
      retryAfterMs: 12_000,
    });
  });

  it("never reports a negative remainder", async () => {
    stubEval([50, 1_000]);

    expect(await consumeRateLimit(options)).toMatchObject({ remaining: 0 });
  });

  it("charges the declared cost", async () => {
    const evaluate = stubEval([3, 60_000]);

    await consumeRateLimit({ ...options, cost: 3 });

    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({
      arguments: ["60000", "3"],
    });
  });

  it("reports a reset time derived from the remaining window", async () => {
    stubEval([1, 30_000]);

    const before = Date.now();
    const result = await consumeRateLimit(options);

    expect(result).toMatchObject({ status: RATE_LIMIT_STATUS.ALLOWED });

    if (result.status === RATE_LIMIT_STATUS.ALLOWED) {
      expect(result.resetAt).toBeGreaterThanOrEqual(before + 30_000);
    }
  });
});

describe("the script and the key", () => {
  it("passes the key through KEYS and the values through ARGV", async () => {
    const evaluate = stubEval([1, 60_000]);

    await consumeRateLimit(options);

    const [script, call] = evaluate.mock.calls[0] as [
      string,
      { keys: string[]; arguments: string[] },
    ];

    expect(call.keys).toEqual([
      `app:test:rate-limit:identity.admin.users.list:${opaqueKeySegment(identity.subject)}`,
    ]);
    expect(call.arguments).toEqual(["60000", "1"]);

    // No key is built inside Lua: a cluster has to be able to route the call,
    // and a value must never be able to become a key name.
    expect(script).not.toMatch(/KEYS\[1\]\s*\.\./);
    expect(script).toContain("KEYS[1]");
  });

  it("makes the increment and the expiry one atomic step", async () => {
    const evaluate = stubEval([1, 60_000]);

    await consumeRateLimit(options);

    const script = evaluate.mock.calls[0]?.[0] as string;

    expect(script).toContain("INCRBY");
    expect(script).toContain("PEXPIRE");
    expect(script).toContain("PTTL");
  });

  it("hashes the subject out of the key", async () => {
    const evaluate = stubEval([1, 60_000]);

    await consumeRateLimit(options);

    expect(JSON.stringify(evaluate.mock.calls)).not.toContain("203.0.113.7");
  });

  it("logs neither the subject nor the key", async () => {
    stubEval([9, 1_000]);

    await consumeRateLimit(options);

    const serialized = JSON.stringify(logCalls);

    expect(serialized).not.toContain("203.0.113.7");
    expect(serialized).not.toContain("app:test:rate-limit");
  });
});

describe("bounds", () => {
  it.each([0, -1, 1.5, MAX_RATE_LIMIT + 1])(
    "refuses the limit %s",
    async (limit) => {
      await expect(consumeRateLimit({ ...options, limit })).rejects.toThrow(
        /rate limit is not acceptable/,
      );
    },
  );

  it.each([MIN_RATE_LIMIT_WINDOW_MS - 1, MAX_RATE_LIMIT_WINDOW_MS + 1, 0, 1.5])(
    "refuses the window %s",
    async (windowMs) => {
      await expect(consumeRateLimit({ ...options, windowMs })).rejects.toThrow(
        /window is not acceptable/,
      );
    },
  );

  it.each([0, -1, 1.5, 6])("refuses the cost %s", async (cost) => {
    await expect(consumeRateLimit({ ...options, cost })).rejects.toThrow(
      /cost is not acceptable/,
    );
  });

  it.each(["has space", "has:separator", "star*", ""])(
    "refuses the limiter name %s",
    async (name) => {
      await expect(
        consumeRateLimit({ ...options, identity: { ...identity, name } }),
      ).rejects.toThrow(/identity is not acceptable/);
    },
  );

  it("refuses an empty subject", async () => {
    await expect(
      consumeRateLimit({ ...options, identity: { ...identity, subject: "" } }),
    ).rejects.toThrow(/subject is not acceptable/);
  });

  it("validates before it touches Redis", async () => {
    await expect(consumeRateLimit({ ...options, limit: 0 })).rejects.toThrow();
    expect(getRedisClient).not.toHaveBeenCalled();
  });
});
