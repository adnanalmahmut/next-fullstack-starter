import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineJob, JOB_BACKOFF_TYPE } from "./define-job";
import { createJobRegistry } from "./job-registry";
import { JOB_REGISTRY } from "./registry";

function job(name: string, version: number) {
  return defineJob({
    name,
    version,
    payloadSchema: z.object({ id: z.string() }).strict(),
    attempts: 1,
    backoff: { type: JOB_BACKOFF_TYPE.FIXED, delayMs: 100 },
    timeoutMs: 1_000,
    timeoutRetryable: false,
    idempotency: { key: (payload) => payload.id },
    handle: async () => undefined,
  });
}

describe("a registry is closed and built once", () => {
  it("resolves a registered job by name and version", () => {
    const registry = createJobRegistry([job("alpha.one", 1)]);

    expect(registry.resolve("alpha.one", 1)?.identity).toBe("alpha.one.v1");
    expect(registry.has("alpha.one", 1)).toBe(true);
  });

  it("lists what it holds, sorted", () => {
    const registry = createJobRegistry([
      job("beta.two", 1),
      job("alpha.one", 2),
      job("alpha.one", 1),
    ]);

    expect(registry.size).toBe(3);
    expect(registry.identities).toEqual([
      "alpha.one.v1",
      "alpha.one.v2",
      "beta.two.v1",
    ]);
    expect(registry.names).toEqual(["alpha.one", "beta.two"]);
  });

  it("refuses a duplicate name and version at construction", () => {
    // At construction means at startup. The alternative is the second
    // definition quietly shadowing the first, discovered in production.
    expect(() =>
      createJobRegistry([job("alpha.one", 1), job("alpha.one", 1)]),
    ).toThrow(/alpha\.one\.v1/);
  });

  it("allows two versions of one job to coexist", () => {
    const registry = createJobRegistry([
      job("alpha.one", 1),
      job("alpha.one", 2),
    ]);

    expect(registry.resolve("alpha.one", 1)).not.toBe(
      registry.resolve("alpha.one", 2),
    );
  });
});

describe("resolving something unknown", () => {
  const registry = createJobRegistry([job("alpha.one", 1)]);

  it("answers null for an unregistered name", () => {
    expect(registry.resolve("gamma.three", 1)).toBeNull();
    expect(registry.hasName("gamma.three")).toBe(false);
  });

  it("separates an unknown name from an unsupported version", () => {
    // The two are different operational facts: one is a message from another
    // system, the other is a message from a different release of this one.
    expect(registry.resolve("alpha.one", 2)).toBeNull();
    expect(registry.hasName("alpha.one")).toBe(true);
  });

  it("answers null rather than throwing on an unacceptable identity", () => {
    // The inputs come off a queue and out of a database column, so they are
    // not trusted; a registry miss is the right answer, not an exception.
    for (const [name, version] of [
      ["Alpha", 1],
      ["alpha.one", 0],
      ["alpha.one", 1.5],
      [42, 1],
      ["alpha.one", "1"],
      [null, null],
    ] as const) {
      expect(
        registry.resolve(name, version),
        `${String(name)}.${String(version)}`,
      ).toBeNull();
    }
  });
});

describe("the application registry", () => {
  it("ships empty", () => {
    // A starter that shipped a plausible business job would be shipping a
    // decision, a table, and a provider nobody asked for.
    expect(JOB_REGISTRY.size).toBe(0);
    expect(JOB_REGISTRY.identities).toEqual([]);
  });

  it("still answers a resolution safely", () => {
    expect(JOB_REGISTRY.resolve("anything.at-all", 1)).toBeNull();
  });
});
