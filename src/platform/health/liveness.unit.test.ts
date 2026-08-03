import { describe, expect, it } from "vitest";

const { LIVENESS_REPORT } = await import("./liveness");
const { HEALTH_CODE } = await import("./health-code");
const { LIVENESS_STATUS } = await import("./health-status");

/**
 * The liveness document.
 *
 * Almost every assertion here is about absence, because that is where the value
 * is: an endpoint reachable without authentication must not describe the machine
 * it runs on, and a body that changed between requests would defeat the simplest
 * thing a monitor can do with it.
 */
describe("the document", () => {
  it("is exactly a status and a code", () => {
    expect(LIVENESS_REPORT).toEqual({
      status: LIVENESS_STATUS.LIVE,
      code: HEALTH_CODE.PROCESS_ALIVE,
    });
    expect(Object.keys(LIVENESS_REPORT).sort()).toEqual(["code", "status"]);
  });

  it("serializes to a stable two-field object", () => {
    expect(JSON.stringify(LIVENESS_REPORT)).toBe(
      '{"status":"live","code":"PROCESS_ALIVE"}',
    );
  });

  it("is byte-identical every time it is read", () => {
    // A liveness answer that changed would make a byte comparison useless, and a
    // byte comparison is the cheapest check an external monitor can perform.
    expect(JSON.stringify(LIVENESS_REPORT)).toBe(
      JSON.stringify(LIVENESS_REPORT),
    );
  });

  it("is frozen, so a caller cannot change what every later probe answers", () => {
    expect(Object.isFrozen(LIVENESS_REPORT)).toBe(true);
  });
});

describe("what it never carries", () => {
  it.each([
    "timestamp",
    "time",
    "now",
    "uptime",
    "hostname",
    "host",
    "pid",
    "processId",
    "memory",
    "memoryUsage",
    "version",
    "commit",
    "environment",
    "env",
    "region",
    "checks",
    "dependencies",
    "database",
    "redis",
    "storage",
    "latencyMs",
    "durationMs",
    "message",
  ])("has no %s field", (field) => {
    expect(LIVENESS_REPORT).not.toHaveProperty(field);
  });

  it("reveals nothing about the machine or the environment", () => {
    const serialized = JSON.stringify(LIVENESS_REPORT);

    // The current process is a genuine source of the values that must not be
    // there, so the real ones are what is searched for.
    for (const forbidden of [
      String(process.pid),
      process.platform,
      process.version,
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("reports no dependency status at all", () => {
    // A liveness probe that reported on a database would eventually be wired to a
    // restart policy, and an orchestrator would kill healthy processes because
    // something they do not own went away.
    expect(Object.values(LIVENESS_REPORT)).toEqual(["live", "PROCESS_ALIVE"]);
  });
});
