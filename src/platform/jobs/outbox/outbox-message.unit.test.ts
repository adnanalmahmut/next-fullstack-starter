import { describe, expect, it } from "vitest";

import {
  MAX_OUTBOX_BACKOFF_MS,
  OUTBOX_DEAD_LETTER_CODE,
  OUTBOX_DEAD_LETTER_CODES,
  OUTBOX_ERROR_CODE,
  outboxBackoffDelayMs,
} from "./outbox-message";

describe("the dead-letter vocabulary", () => {
  it("names every reason a message cannot be understood", () => {
    expect([...OUTBOX_DEAD_LETTER_CODES].sort()).toEqual([
      "INVALID_PAYLOAD",
      "PAYLOAD_TOO_LARGE",
      "PUBLISH_ATTEMPTS_EXHAUSTED",
      "UNKNOWN_JOB",
      "UNSUPPORTED_VERSION",
    ]);
  });

  it("separates an unknown job from an unsupported version", () => {
    expect(OUTBOX_DEAD_LETTER_CODE.UNKNOWN_JOB).not.toBe(
      OUTBOX_DEAD_LETTER_CODE.UNSUPPORTED_VERSION,
    );
  });

  it("keeps publish failures to a closed set of codes", () => {
    // `lastErrorCode` is a column; a column that could hold an exception
    // message would eventually hold a connection string.
    for (const code of Object.values(OUTBOX_ERROR_CODE)) {
      expect(code, code).toMatch(/^[a-z][a-z-]*$/);
    }
  });
});

describe("the publish backoff", () => {
  it("starts at the base delay", () => {
    expect(outboxBackoffDelayMs(1, 1_000)).toBe(1_000);
  });

  it("doubles with each attempt", () => {
    expect(outboxBackoffDelayMs(2, 1_000)).toBe(2_000);
    expect(outboxBackoffDelayMs(3, 1_000)).toBe(4_000);
    expect(outboxBackoffDelayMs(4, 1_000)).toBe(8_000);
  });

  it("is capped, so a much-failed row still comes back today", () => {
    expect(outboxBackoffDelayMs(50, 1_000)).toBe(MAX_OUTBOX_BACKOFF_MS);
  });

  it("treats a zeroth attempt as the first", () => {
    expect(outboxBackoffDelayMs(0, 1_000)).toBe(1_000);
    expect(outboxBackoffDelayMs(-5, 1_000)).toBe(1_000);
  });

  it("spreads rows apart with a seed", () => {
    // Without a spread, an outage lines every failed row up on the same
    // millisecond and the recovery is a thundering herd.
    const first = outboxBackoffDelayMs(3, 1_000, "row-a");
    const second = outboxBackoffDelayMs(3, 1_000, "row-b");

    expect(first).not.toBe(second);
    expect(first).toBeGreaterThanOrEqual(4_000);
    expect(first).toBeLessThan(4_400);
    expect(second).toBeLessThan(4_400);
  });

  it("gives the same row the same answer every time", () => {
    // Deterministic rather than random, so a test can assert it and an operator
    // can predict it.
    expect(outboxBackoffDelayMs(3, 1_000, "row-a")).toBe(
      outboxBackoffDelayMs(3, 1_000, "row-a"),
    );
  });
});
