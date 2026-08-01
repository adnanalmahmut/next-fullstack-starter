import { describe, expect, it } from "vitest";

import {
  isRedisNamespace,
  REDIS_NAMESPACE,
  REDIS_NAMESPACES,
} from "./namespace";

describe("Redis namespaces", () => {
  it("declares the closed set once, in declaration order", () => {
    expect(REDIS_NAMESPACES).toEqual([
      "cache",
      "rate-limit",
      "lock",
      "temporary",
      "idempotency",
    ]);
  });

  it("carries no separator or wildcard in a name", () => {
    for (const namespace of REDIS_NAMESPACES) {
      expect(namespace, namespace).toMatch(/^[a-z][a-z-]*$/);
    }
  });

  it("keeps every name distinct and non-overlapping", () => {
    expect(new Set(REDIS_NAMESPACES).size).toBe(REDIS_NAMESPACES.length);

    for (const namespace of REDIS_NAMESPACES) {
      const others = REDIS_NAMESPACES.filter((other) => other !== namespace);

      expect(others.some((other) => other.startsWith(`${namespace}-`))).toBe(
        false,
      );
    }
  });

  it("recognizes only a declared namespace", () => {
    for (const namespace of Object.values(REDIS_NAMESPACE)) {
      expect(isRedisNamespace(namespace)).toBe(true);
    }

    for (const value of ["session", "queue", "", undefined, null, 1]) {
      expect(isRedisNamespace(value), String(value)).toBe(false);
    }
  });
});
