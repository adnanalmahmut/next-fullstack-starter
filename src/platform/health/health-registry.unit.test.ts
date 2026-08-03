import { describe, expect, it, vi } from "vitest";

import type { DependencyCheck } from "./dependency-check";

const { createHealthRegistry } = await import("./health-registry");
const {
  DEPENDENCY_FAILURE_CODE,
  DEPENDENCY_NAME,
  HEALTHY_DEPENDENCY,
  MAX_DEPENDENCY_TIMEOUT_MS,
  MIN_DEPENDENCY_TIMEOUT_MS,
} = await import("./dependency-check");

/**
 * The registry.
 *
 * The immutability tests are the ones that matter. A mutable health registry
 * produces a failure that never announces itself: the set of checks a probe runs
 * would depend on which modules had been imported by the time the first request
 * arrived, so two instances of one deployment could disagree about whether they
 * are ready.
 */
function check(overrides: Partial<DependencyCheck> = {}): DependencyCheck {
  return {
    name: DEPENDENCY_NAME.DATABASE,
    timeoutMs: 1_000,
    failureCode: DEPENDENCY_FAILURE_CODE.DATABASE,
    run: async () => HEALTHY_DEPENDENCY,
    ...overrides,
  };
}

describe("construction", () => {
  it("keeps the declared checks in declaration order", () => {
    const registry = createHealthRegistry([
      check({ name: DEPENDENCY_NAME.DATABASE }),
      check({
        name: DEPENDENCY_NAME.REDIS,
        failureCode: DEPENDENCY_FAILURE_CODE.REDIS,
      }),
      check({
        name: DEPENDENCY_NAME.STORAGE,
        failureCode: DEPENDENCY_FAILURE_CODE.STORAGE,
      }),
    ]);

    expect(registry.names).toEqual(["database", "redis", "storage"]);
    expect(registry.checks).toHaveLength(3);
  });

  it("accepts a check at each end of the timeout range", () => {
    expect(() =>
      createHealthRegistry([
        check({ timeoutMs: MIN_DEPENDENCY_TIMEOUT_MS }),
        check({
          name: DEPENDENCY_NAME.REDIS,
          timeoutMs: MAX_DEPENDENCY_TIMEOUT_MS,
        }),
      ]),
    ).not.toThrow();
  });
});

describe("refusals", () => {
  it("refuses an empty registry", () => {
    // A registry with no checks would answer `ready` without having asked
    // anything, which is worse than answering nothing at all.
    expect(() => createHealthRegistry([])).toThrow(/at least one check/);
  });

  it("refuses a duplicated dependency name", () => {
    expect(() =>
      createHealthRegistry([
        check({ name: DEPENDENCY_NAME.DATABASE }),
        check({ name: DEPENDENCY_NAME.DATABASE }),
      ]),
    ).toThrow(/name twice/);
  });

  it.each([
    { name: "zero", timeoutMs: 0 },
    { name: "a negative value", timeoutMs: -1 },
    { name: "below the floor", timeoutMs: MIN_DEPENDENCY_TIMEOUT_MS - 1 },
    { name: "above the ceiling", timeoutMs: MAX_DEPENDENCY_TIMEOUT_MS + 1 },
    { name: "a fraction", timeoutMs: 500.5 },
    { name: "not a number", timeoutMs: Number.NaN },
    { name: "infinity", timeoutMs: Number.POSITIVE_INFINITY },
  ])("refuses a timeout that is $name", ({ timeoutMs }) => {
    expect(() => createHealthRegistry([check({ timeoutMs })])).toThrow(
      /bounded timeout/,
    );
  });

  it("refuses a check with no callable probe", () => {
    expect(() =>
      createHealthRegistry([
        check({ run: undefined as unknown as DependencyCheck["run"] }),
      ]),
    ).toThrow(/callable probe/);
  });

  it("reports the first problem it finds rather than an aggregate", () => {
    expect(() =>
      createHealthRegistry([check({ timeoutMs: 0 }), check({ timeoutMs: 0 })]),
    ).toThrow(/bounded timeout/);
  });
});

describe("immutability", () => {
  it("freezes the registry and both of its lists", () => {
    const registry = createHealthRegistry([check()]);

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.checks)).toBe(true);
    expect(Object.isFrozen(registry.names)).toBe(true);
  });

  it("copies the declared list, so a later mutation cannot widen it", () => {
    const declared = [check()];
    const registry = createHealthRegistry(declared);

    declared.push(
      check({
        name: DEPENDENCY_NAME.REDIS,
        failureCode: DEPENDENCY_FAILURE_CODE.REDIS,
      }),
    );

    expect(registry.checks).toHaveLength(1);
    expect(registry.names).toEqual(["database"]);
  });

  it("exposes no way to register a check after construction", () => {
    const registry = createHealthRegistry([check()]);

    for (const forbidden of ["register", "add", "push", "set", "remove"]) {
      expect(registry, forbidden).not.toHaveProperty(forbidden);
    }
  });

  it("runs nothing while being constructed", () => {
    const run = vi.fn(async () => HEALTHY_DEPENDENCY);

    createHealthRegistry([check({ run })]);

    expect(run).not.toHaveBeenCalled();
  });

  it("holds nothing on globalThis", () => {
    createHealthRegistry([check()]);

    const keys = Object.keys(globalThis).filter((key) =>
      key.toLowerCase().includes("health"),
    );

    expect(keys).toEqual([]);
  });
});
