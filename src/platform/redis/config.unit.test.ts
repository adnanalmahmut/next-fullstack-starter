import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getRedisConfiguration,
  getRedisKeyScope,
  isRedisEnabled,
  resetRedisConfiguration,
} from "./config";
import { redisScopePrefix } from "./key";

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

describe("configuration", () => {
  it("is disabled and carries no URL by default", () => {
    const configuration = getRedisConfiguration();

    expect(configuration.enabled).toBe(false);
    expect(isRedisEnabled()).toBe(false);
    expect(Object.keys(configuration).sort()).toEqual([
      "connectTimeoutMs",
      "enabled",
      "keyPrefix",
    ]);
  });

  it("exposes the URL only once enabled", () => {
    process.env.REDIS_ENABLED = "true";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    resetRedisConfiguration();

    const configuration = getRedisConfiguration();

    expect(configuration.enabled).toBe(true);

    if (configuration.enabled) {
      expect(configuration.url).toBe("redis://127.0.0.1:6379");
    }
  });

  it("memoizes so one process reads one configuration", () => {
    const first = getRedisConfiguration();

    process.env.REDIS_ENABLED = "true";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";

    expect(getRedisConfiguration()).toBe(first);
    expect(getRedisConfiguration().enabled).toBe(false);
  });

  it("re-reads only after an explicit reset", () => {
    expect(getRedisConfiguration().enabled).toBe(false);

    process.env.REDIS_ENABLED = "true";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    resetRedisConfiguration();

    expect(getRedisConfiguration().enabled).toBe(true);
  });
});

describe("key scope", () => {
  it("carries a run identifier under test", () => {
    process.env.REDIS_TEST_RUN_ID = "run-fixed";
    process.env.REDIS_TEST_WORKER_ID = "4";
    resetRedisConfiguration();

    expect(redisScopePrefix(getRedisKeyScope())).toBe(
      "next-fullstack-starter:test:run-fixed:4",
    );
  });

  it("generates a run identifier when none is supplied", () => {
    const scope = getRedisKeyScope();

    expect(scope.environment).toBe("test");
    expect(scope.testRunId).toMatch(/^run-[0-9a-f-]{36}$/);
  });

  it("gives two resets two different run identifiers", () => {
    const first = getRedisKeyScope().testRunId;

    resetRedisConfiguration();

    expect(getRedisKeyScope().testRunId).not.toBe(first);
  });

  it("memoizes so keys written and scanned share one scope", () => {
    expect(getRedisKeyScope()).toBe(getRedisKeyScope());
  });

  it("honours a custom prefix", () => {
    process.env.REDIS_KEY_PREFIX = "acme";
    process.env.REDIS_TEST_RUN_ID = "run-1";
    process.env.REDIS_TEST_WORKER_ID = "1";
    resetRedisConfiguration();

    expect(redisScopePrefix(getRedisKeyScope())).toBe("acme:test:run-1:1");
  });

  it("separates parallel workers of one run", () => {
    // The runner's own worker identifier is picked up when none is exported, so
    // two workers of the same run cannot write into one key space by default.
    process.env.REDIS_TEST_RUN_ID = "run-1";
    resetRedisConfiguration();

    const scope = getRedisKeyScope();

    expect(scope.testWorkerId).toBe(process.env.VITEST_WORKER_ID);
    expect(scope.testWorkerId).toBeDefined();
  });
});
