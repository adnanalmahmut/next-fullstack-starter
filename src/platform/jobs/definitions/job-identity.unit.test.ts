import { describe, expect, it } from "vitest";

import {
  isValidJobName,
  isValidJobVersion,
  jobIdentity,
  MAX_JOB_NAME_LENGTH,
  MAX_JOB_VERSION,
  parseJobIdentity,
} from "./job-identity";

describe("a job name", () => {
  it.each(["identity.user-deleted", "billing.invoice.send", "a.b"])(
    "accepts %j",
    (name) => {
      expect(isValidJobName(name)).toBe(true);
    },
  );

  it("requires a dot, so two areas cannot both own a bare word", () => {
    expect(isValidJobName("cleanup")).toBe(false);
  });

  it.each([
    "Identity.userDeleted",
    "identity user",
    "identity..user",
    ".identity.user",
    "identity.user.",
    "identity:user",
    "identity.user*",
    "1identity.user",
    "",
  ])("refuses %j", (name) => {
    expect(isValidJobName(name)).toBe(false);
  });

  it("is bounded, because it becomes part of a key and of every log line", () => {
    const long = `a.${"b".repeat(MAX_JOB_NAME_LENGTH)}`;

    expect(long.length).toBeGreaterThan(MAX_JOB_NAME_LENGTH);
    expect(isValidJobName(long)).toBe(false);
  });

  it("refuses a value that is not a string", () => {
    for (const value of [undefined, null, 7, {}, ["a.b"]]) {
      expect(isValidJobName(value)).toBe(false);
    }
  });
});

describe("a job version", () => {
  it("is a positive integer", () => {
    expect(isValidJobVersion(1)).toBe(true);
    expect(isValidJobVersion(MAX_JOB_VERSION)).toBe(true);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_JOB_VERSION + 1,
  ])("refuses %j", (version) => {
    expect(isValidJobVersion(version)).toBe(false);
  });

  it("refuses a numeric string", () => {
    // A version arrives from a database column and from a JSON envelope. "1"
    // and 1 must not both be accepted, or two spellings of one version would
    // resolve to two registry misses.
    expect(isValidJobVersion("1")).toBe(false);
  });
});

describe("the full identity", () => {
  it("is the name, the marker, and the version", () => {
    expect(jobIdentity("identity.user-deleted", 2)).toBe(
      "identity.user-deleted.v2",
    );
  });

  it("refuses to build one from an unacceptable part", () => {
    expect(() => jobIdentity("Cleanup", 1)).toThrow(/job name/);
    expect(() => jobIdentity("a.b", 0)).toThrow(/job version/);
  });

  it("round-trips", () => {
    expect(parseJobIdentity(jobIdentity("billing.invoice.send", 12))).toEqual({
      name: "billing.invoice.send",
      version: 12,
    });
  });

  it("answers null rather than throwing on an unparseable value", () => {
    // The caller is normally looking at something that arrived from Redis; an
    // unparseable identity is a message to dead-letter, not an exception to
    // propagate through a worker loop.
    for (const value of [
      "",
      "identity.user",
      "identity.user.v",
      "identity.user.v0",
      "identity.user.v01",
      "identity.user.v1.5",
      "identity.user.vabc",
      ".v1",
      42,
      null,
      undefined,
    ]) {
      expect(parseJobIdentity(value), String(value)).toBeNull();
    }
  });

  it("reads the version from the last marker, not the first", () => {
    // A name may legitimately contain a segment starting with "v".
    expect(parseJobIdentity("billing.void.v3")).toEqual({
      name: "billing.void",
      version: 3,
    });
  });
});
