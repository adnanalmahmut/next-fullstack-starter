import { describe, expect, it } from "vitest";

import { readRedisEnvironment } from "./read-redis";
import {
  DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
  DEFAULT_REDIS_KEY_PREFIX,
  MAX_REDIS_CONNECT_TIMEOUT_MS,
  MIN_REDIS_CONNECT_TIMEOUT_MS,
  redisEnvironmentSchema,
} from "./schema";

describe("Redis is optional", () => {
  it("reads a disabled configuration from an empty environment", () => {
    expect(readRedisEnvironment({})).toEqual({
      REDIS_ENABLED: false,
      REDIS_KEY_PREFIX: DEFAULT_REDIS_KEY_PREFIX,
      REDIS_CONNECT_TIMEOUT_MS: DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
    });
  });

  it("needs no URL while it is disabled", () => {
    expect(
      readRedisEnvironment({ REDIS_ENABLED: "false" }).REDIS_URL,
    ).toBeUndefined();
  });

  it("is not part of the required server environment", async () => {
    const { serverEnvironmentSchema } = await import("./schema");
    const shape = Object.keys(serverEnvironmentSchema.shape);

    expect(shape).toEqual(["APP_ENV", "NODE_ENV", "BETTER_AUTH_SECRET"]);
    expect(shape.some((key) => key.startsWith("REDIS_"))).toBe(false);
  });

  it("is not exported from the eager configuration entry point", async () => {
    const entryPoint = await import("./index.server");

    expect(Object.keys(entryPoint).sort()).toEqual([
      "databaseEnv",
      "serverEnv",
    ]);
  });
});

describe("conditional URL requirement", () => {
  it("requires a URL once enabled", () => {
    const result = redisEnvironmentSchema.safeParse({ REDIS_ENABLED: "true" });

    expect(result.success).toBe(false);
    expect(() => readRedisEnvironment({ REDIS_ENABLED: "true" })).toThrow(
      /REDIS_URL/,
    );
  });

  it.each(["redis://127.0.0.1:6379", "rediss://cache.example.com:6380"])(
    "accepts %s",
    (url) => {
      expect(
        readRedisEnvironment({ REDIS_ENABLED: "true", REDIS_URL: url }),
      ).toMatchObject({ REDIS_ENABLED: true, REDIS_URL: url });
    },
  );

  it.each([
    "http://127.0.0.1:6379",
    "https://cache.example.com",
    "postgresql://127.0.0.1:5432/app",
    "unix:///var/run/redis.sock",
    "127.0.0.1:6379",
    "not a url",
  ])("refuses %s", (url) => {
    expect(
      redisEnvironmentSchema.safeParse({
        REDIS_ENABLED: "true",
        REDIS_URL: url,
      }).success,
    ).toBe(false);
  });

  it("refuses an unrecognized flag value", () => {
    for (const flag of ["yes", "1", "TRUE", ""]) {
      expect(
        redisEnvironmentSchema.safeParse({ REDIS_ENABLED: flag }).success,
        flag,
      ).toBe(false);
    }
  });

  it("refuses an unknown Redis variable", () => {
    expect(
      redisEnvironmentSchema.safeParse({ REDIS_DATABASE: "3" }).success,
    ).toBe(false);
  });
});

describe("key prefix", () => {
  it("has a safe default", () => {
    expect(DEFAULT_REDIS_KEY_PREFIX).toBe("next-fullstack-starter");
    expect(readRedisEnvironment({}).REDIS_KEY_PREFIX).toBe(
      DEFAULT_REDIS_KEY_PREFIX,
    );
  });

  it("accepts a plausible prefix", () => {
    expect(
      readRedisEnvironment({ REDIS_KEY_PREFIX: "acme-shop.eu" })
        .REDIS_KEY_PREFIX,
    ).toBe("acme-shop.eu");
  });

  it.each([
    "",
    "with space",
    "has:separator",
    "star*",
    "-leading",
    "A".repeat(65),
  ])("refuses %s", (prefix) => {
    expect(
      redisEnvironmentSchema.safeParse({ REDIS_KEY_PREFIX: prefix }).success,
    ).toBe(false);
  });
});

describe("connect timeout", () => {
  it("has a bounded default", () => {
    expect(readRedisEnvironment({}).REDIS_CONNECT_TIMEOUT_MS).toBe(
      DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
    );
    expect(DEFAULT_REDIS_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(
      MIN_REDIS_CONNECT_TIMEOUT_MS,
    );
    expect(DEFAULT_REDIS_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(
      MAX_REDIS_CONNECT_TIMEOUT_MS,
    );
  });

  it("coerces a numeric string", () => {
    expect(
      readRedisEnvironment({ REDIS_CONNECT_TIMEOUT_MS: "250" })
        .REDIS_CONNECT_TIMEOUT_MS,
    ).toBe(250);
  });

  it.each([
    String(MIN_REDIS_CONNECT_TIMEOUT_MS - 1),
    String(MAX_REDIS_CONNECT_TIMEOUT_MS + 1),
    "0",
    "-1",
    "1.5",
    "forever",
  ])("refuses %s", (timeout) => {
    expect(
      redisEnvironmentSchema.safeParse({ REDIS_CONNECT_TIMEOUT_MS: timeout })
        .success,
    ).toBe(false);
  });
});

describe("test identifiers", () => {
  it("accepts an explicit run and worker identifier", () => {
    expect(
      readRedisEnvironment({
        REDIS_TEST_RUN_ID: "ci-1234",
        REDIS_TEST_WORKER_ID: "3",
      }),
    ).toMatchObject({
      REDIS_TEST_RUN_ID: "ci-1234",
      REDIS_TEST_WORKER_ID: "3",
    });
  });

  it("falls back to the test runner's worker identifier", () => {
    expect(
      readRedisEnvironment({ VITEST_WORKER_ID: "7" }).REDIS_TEST_WORKER_ID,
    ).toBe("7");
  });

  it("prefers an explicit worker identifier over the runner's", () => {
    expect(
      readRedisEnvironment({
        REDIS_TEST_WORKER_ID: "explicit",
        VITEST_WORKER_ID: "7",
      }).REDIS_TEST_WORKER_ID,
    ).toBe("explicit");
  });

  it.each(["has:separator", "has space", "star*", ""])(
    "refuses the identifier %s",
    (identifier) => {
      expect(
        redisEnvironmentSchema.safeParse({ REDIS_TEST_RUN_ID: identifier })
          .success,
      ).toBe(false);
    },
  );
});

describe("failure reporting", () => {
  it("names the scope and the variable without printing a credential", () => {
    const url = "redis://admin:hunter2@cache.internal:6379";

    try {
      readRedisEnvironment({
        REDIS_ENABLED: "true",
        REDIS_URL: url,
        REDIS_CONNECT_TIMEOUT_MS: "0",
      });
      expect.unreachable("the configuration should have been refused");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      expect(message).toContain("redis");
      expect(message).toContain("REDIS_CONNECT_TIMEOUT_MS");
      expect(message).not.toContain("hunter2");
      expect(message).not.toContain("cache.internal");
      expect(message).not.toContain(url);
    }
  });
});
