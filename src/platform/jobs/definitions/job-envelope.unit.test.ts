import { describe, expect, it } from "vitest";

import {
  checkJobPayload,
  isJsonValue,
  isValidJobIdentifier,
  jobEnvelopeSchema,
  jobPayloadByteLength,
  MAX_JOB_PAYLOAD_BYTES,
  PAYLOAD_REJECTION,
} from "./job-envelope";

const validEnvelope = {
  jobName: "identity.user-deleted",
  version: 1,
  payload: { userId: "u-1" },
  outboxId: "0193f0a1-0000-7000-8000-000000000000",
  correlationId: "0193f0a1-0000-7000-8000-000000000001",
  occurredAt: "2026-08-01T12:00:00.000Z",
};

describe("the envelope", () => {
  it("accepts a well-formed message", () => {
    expect(jobEnvelopeSchema.safeParse(validEnvelope).success).toBe(true);
  });

  it("carries the optional fields when they are present", () => {
    const result = jobEnvelopeSchema.parse({
      ...validEnvelope,
      causationId: "0193f0a1-0000-7000-8000-000000000002",
      traceContext: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    });

    expect(result.causationId).toBeDefined();
    expect(result.traceContext?.traceparent).toBeDefined();
  });

  it.each([
    ["an unknown field", { ...validEnvelope, actor: { id: "u-1" } }],
    ["a header bag", { ...validEnvelope, headers: {} }],
    ["a cookie", { ...validEnvelope, cookie: "session=abc" }],
  ])("refuses %s", (_name, value) => {
    // Strict, so a field nobody validated cannot ride along into a durable row.
    expect(jobEnvelopeSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["a bad job name", { jobName: "Cleanup" }],
    ["a bad version", { version: 0 }],
    ["a missing outbox id", { outboxId: undefined }],
    ["a non-identifier correlation id", { correlationId: "a b" }],
    ["a non-ISO timestamp", { occurredAt: "yesterday" }],
  ])("refuses %s", (_name, override) => {
    expect(
      jobEnvelopeSchema.safeParse({ ...validEnvelope, ...override }).success,
    ).toBe(false);
  });
});

describe("an identifier", () => {
  it.each(["u-1", "0193f0a1-0000-7000-8000-000000000000", "run.1:2"])(
    "accepts %j",
    (value) => {
      expect(isValidJobIdentifier(value)).toBe(true);
    },
  );

  it.each(["", " ", "a b", "-lead", "a\nb", "a/b"])("refuses %j", (value) => {
    expect(isValidJobIdentifier(value)).toBe(false);
  });

  it("is bounded", () => {
    expect(isValidJobIdentifier("a".repeat(129))).toBe(false);
  });
});

describe("a payload has to survive JSON", () => {
  it.each([
    ["null", null],
    ["a string", "value"],
    ["a finite number", 1.5],
    ["a boolean", true],
    ["an array", [1, "two", null]],
    ["a plain object", { a: { b: [1] } }],
    [
      "an object with no prototype",
      Object.assign(Object.create(null), { a: 1 }),
    ],
  ])("accepts %s", (_name, value) => {
    expect(isJsonValue(value)).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["a function", () => undefined],
    ["a symbol", Symbol("s")],
    ["a bigint", BigInt(1)],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a Date", new Date()],
    ["a Map", new Map()],
    ["a Set", new Set()],
    ["a Buffer", Buffer.from("x")],
    ["a class instance", new (class Thing {})()],
    ["a nested Date", { at: new Date() }],
    ["an array holding undefined", [undefined]],
  ])("refuses %s", (_name, value) => {
    // Each of these survives `JSON.stringify` as something else, and the
    // difference only surfaces inside a worker, days later.
    expect(isJsonValue(value)).toBe(false);
  });
});

describe("the transport limits", () => {
  it("measures the payload the way Redis will store it", () => {
    expect(jobPayloadByteLength({ a: "é" })).toBe(
      Buffer.byteLength(JSON.stringify({ a: "é" }), "utf8"),
    );
  });

  it("accepts a payload inside the limit", () => {
    expect(checkJobPayload({ note: "x".repeat(1_000) })).toBeNull();
  });

  it("names an oversized payload as oversized", () => {
    const payload = { note: "x".repeat(MAX_JOB_PAYLOAD_BYTES) };

    expect(checkJobPayload(payload)).toBe(PAYLOAD_REJECTION.TOO_LARGE);
  });

  it("names an unserializable payload as such", () => {
    expect(checkJobPayload({ at: new Date() })).toBe(
      PAYLOAD_REJECTION.NOT_JSON,
    );
    expect(checkJobPayload(undefined)).toBe(PAYLOAD_REJECTION.NOT_JSON);
  });

  it("separates the two reasons, because they are fixed differently", () => {
    expect(PAYLOAD_REJECTION.TOO_LARGE).not.toBe(PAYLOAD_REJECTION.NOT_JSON);
  });
});
