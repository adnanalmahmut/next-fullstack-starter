import { describe, expect, it } from "vitest";

import {
  buildRedisKey,
  isValidRedisKeySegment,
  redisNamespacePattern,
  redisScopePattern,
  redisScopePrefix,
  type RedisKeyScope,
} from "./key";
import { REDIS_NAMESPACE } from "./namespace";

const productionScope: RedisKeyScope = {
  prefix: "next-fullstack-starter",
  environment: "production",
};

const testScope: RedisKeyScope = {
  prefix: "next-fullstack-starter",
  environment: "test",
  testRunId: "run-1",
  testWorkerId: "2",
};

describe("scope prefix", () => {
  it("uses the prefix and the environment", () => {
    expect(redisScopePrefix(productionScope)).toBe(
      "next-fullstack-starter:production",
    );
  });

  it("adds the run and worker identifiers under test", () => {
    expect(redisScopePrefix(testScope)).toBe(
      "next-fullstack-starter:test:run-1:2",
    );
  });

  it("omits a worker identifier that was not supplied", () => {
    expect(
      redisScopePrefix({
        prefix: "app",
        environment: "test",
        testRunId: "run-1",
      }),
    ).toBe("app:test:run-1");
  });

  it.each([
    { name: "an empty prefix", scope: { prefix: "", environment: "test" } },
    {
      name: "a separator in the prefix",
      scope: { prefix: "a:b", environment: "test" },
    },
    {
      name: "a wildcard in the environment",
      scope: { prefix: "app", environment: "te*st" },
    },
    {
      name: "a separator in the run identifier",
      scope: { prefix: "app", environment: "test", testRunId: "run:1" },
    },
  ])("refuses $name", ({ scope }) => {
    expect(() => redisScopePrefix(scope)).toThrow(/scope is not acceptable/);
  });
});

describe("key construction", () => {
  it("places the namespace between the scope and the segments", () => {
    expect(
      buildRedisKey(productionScope, REDIS_NAMESPACE.CACHE, "user", "user-1"),
    ).toBe("next-fullstack-starter:production:cache:user:user-1");
  });

  it("scopes a test key to its run and worker", () => {
    expect(
      buildRedisKey(testScope, REDIS_NAMESPACE.RATE_LIMIT, "ip", "1"),
    ).toBe("next-fullstack-starter:test:run-1:2:rate-limit:ip:1");
  });

  it.each(Object.values(REDIS_NAMESPACE))(
    "builds a key in the %s namespace",
    (namespace) => {
      expect(buildRedisKey(productionScope, namespace, "subject")).toBe(
        `next-fullstack-starter:production:${namespace}:subject`,
      );
    },
  );

  it("requires at least one segment", () => {
    expect(() => buildRedisKey(productionScope, REDIS_NAMESPACE.LOCK)).toThrow(
      /at least one segment/,
    );
  });

  it.each([
    { name: "an empty segment", segment: "" },
    { name: "a separator", segment: "a:b" },
    { name: "a wildcard", segment: "user-*" },
    { name: "a question mark", segment: "user-?" },
    { name: "a bracket", segment: "user-[1]" },
    { name: "whitespace", segment: "user 1" },
    { name: "a newline", segment: "user\n1" },
    { name: "a leading separator", segment: ":user" },
    { name: "an oversized segment", segment: "a".repeat(129) },
  ])("refuses $name", ({ segment }) => {
    expect(() =>
      buildRedisKey(productionScope, REDIS_NAMESPACE.CACHE, segment),
    ).toThrow(/segment is not acceptable/);
  });

  it("refuses a non-string segment", () => {
    for (const segment of [undefined, null, 1, {}]) {
      expect(isValidRedisKeySegment(segment), String(segment)).toBe(false);
    }
  });

  it("accepts the characters an identifier normally carries", () => {
    for (const segment of ["user-1", "user_1", "user.1", "a@b", "AbC123"]) {
      expect(isValidRedisKeySegment(segment), segment).toBe(true);
    }
  });
});

describe("scan patterns", () => {
  it("bounds a namespace pattern to the scope", () => {
    expect(redisNamespacePattern(testScope, REDIS_NAMESPACE.CACHE)).toBe(
      "next-fullstack-starter:test:run-1:2:cache:*",
    );
  });

  it("bounds a scope pattern to the scope", () => {
    expect(redisScopePattern(testScope)).toBe(
      "next-fullstack-starter:test:run-1:2:*",
    );
  });

  it("cannot match another run's keys", () => {
    const otherRun: RedisKeyScope = { ...testScope, testRunId: "run-2" };
    const pattern = redisScopePattern(testScope);
    const otherKey = buildRedisKey(otherRun, REDIS_NAMESPACE.CACHE, "user-1");

    expect(otherKey.startsWith(pattern.slice(0, -1))).toBe(false);
  });

  it("puts the only wildcard at the end", () => {
    for (const pattern of [
      redisScopePattern(testScope),
      redisNamespacePattern(testScope, REDIS_NAMESPACE.LOCK),
    ]) {
      expect(pattern.indexOf("*")).toBe(pattern.length - 1);
    }
  });
});
