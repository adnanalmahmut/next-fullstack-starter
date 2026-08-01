import { describe, expect, it } from "vitest";

import {
  CONTROL_MODULE,
  CONTROL_OUTCOME,
  toControlLogFields,
} from "./control-log-fields";

const ALLOWED_FIELDS = [
  "module",
  "operation",
  "routeName",
  "requestId",
  "durationMs",
  "outcome",
  "errorCode",
  "retryAfterMs",
  "ttlMs",
];

describe("the allowlist", () => {
  it("carries the two fields every line must have", () => {
    expect(
      toControlLogFields({
        module: CONTROL_MODULE.CACHE,
        operation: "cache-aside",
      }),
    ).toEqual({ module: "cache", operation: "cache-aside" });
  });

  it("omits an absent value rather than claiming to know it", () => {
    // `null` in a log line reads as a fact. Absence is not a fact.
    const fields = toControlLogFields({
      module: CONTROL_MODULE.CONCURRENCY,
      operation: "lock",
      outcome: undefined,
      durationMs: undefined,
      ttlMs: undefined,
    });

    expect(Object.keys(fields)).toEqual(["module", "operation"]);
  });

  it("carries every allowlisted field when it is supplied", () => {
    const fields = toControlLogFields({
      module: CONTROL_MODULE.CONCURRENCY,
      operation: "rate-limit",
      routeName: "identity.admin.users.list",
      requestId: "0f1c4a0e-1d3f-4d5e-8a7b-9c0d1e2f3a4b",
      durationMs: 12,
      outcome: CONTROL_OUTCOME.UNAVAILABLE,
      errorCode: "DEPENDENCY_UNAVAILABLE",
      retryAfterMs: 5_000,
      ttlMs: 60_000,
    });

    expect(Object.keys(fields).sort()).toEqual([...ALLOWED_FIELDS].sort());
  });

  it("drops anything the allowlist does not name", () => {
    const fields = toControlLogFields({
      module: CONTROL_MODULE.CACHE,
      operation: "cache-aside",
      // A caller that reached for a forbidden field gets nothing, at the one
      // place every control line is built rather than at each call site.
      ...({
        key: "app:test:cache:identity:user:v1:user-1",
        value: { name: "Ada" },
        token: "8f14e45fceea167a5a36dedd4bea2543",
        subject: "person@example.test",
      } as unknown as Record<string, never>),
    });

    expect(Object.keys(fields)).toEqual(["module", "operation"]);
    expect(JSON.stringify(fields)).not.toContain("person");
  });

  it("names exactly two modules", () => {
    expect(Object.values(CONTROL_MODULE)).toEqual(["cache", "concurrency"]);
  });

  it("offers reasons rather than restatements of the event", () => {
    // `cache.bypassed` is worth a line either way; `disabled` and `unavailable`
    // are two very different operational facts and only this field separates
    // them. None of these values repeats an event name.
    expect(Object.values(CONTROL_OUTCOME)).toEqual([
      "disabled",
      "unavailable",
      "degraded",
      "expired",
      "corrupt",
      "oversized",
    ]);
  });
});
