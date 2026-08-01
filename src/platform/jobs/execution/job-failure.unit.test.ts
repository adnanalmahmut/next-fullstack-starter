import { describe, expect, it } from "vitest";

import {
  isPermanentJobFailure,
  JOB_FAILURE_CODE,
  JOB_FAILURE_CODES,
  JobTimeoutError,
  PermanentJobError,
  toJobFailureCode,
} from "./job-failure";

describe("the default is retryable", () => {
  it("treats a plain error as transient", () => {
    // Most failures genuinely are transient, and the opposite default would
    // silently drop work on the first hiccup.
    expect(isPermanentJobFailure(new Error("connection reset"))).toBe(false);
    expect(toJobFailureCode(new Error("connection reset"))).toBe(
      JOB_FAILURE_CODE.HANDLER_FAILED,
    );
  });

  it("treats a thrown non-error as transient too", () => {
    expect(isPermanentJobFailure("nope")).toBe(false);
    expect(toJobFailureCode("nope")).toBe(JOB_FAILURE_CODE.HANDLER_FAILED);
  });
});

describe("a permanent failure", () => {
  it("is recognised and keeps its code", () => {
    const error = new PermanentJobError(
      JOB_FAILURE_CODE.INVALID_PAYLOAD,
      "The job payload does not match its schema.",
    );

    expect(isPermanentJobFailure(error)).toBe(true);
    expect(toJobFailureCode(error)).toBe(JOB_FAILURE_CODE.INVALID_PAYLOAD);
  });

  it("survives the prototype chain being crossed", () => {
    const error = new PermanentJobError(JOB_FAILURE_CODE.UNKNOWN_JOB, "x");

    expect(error).toBeInstanceOf(PermanentJobError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PermanentJobError");
  });
});

describe("a timeout", () => {
  it("is permanent or transient according to the definition", () => {
    // There is no safe default: a slow dependency should come back, work that
    // does not fit its budget will only burn the retries.
    expect(isPermanentJobFailure(new JobTimeoutError(true))).toBe(false);
    expect(isPermanentJobFailure(new JobTimeoutError(false))).toBe(true);
  });

  it("always reports the same code", () => {
    expect(toJobFailureCode(new JobTimeoutError(true))).toBe(
      JOB_FAILURE_CODE.TIMED_OUT,
    );
    expect(toJobFailureCode(new JobTimeoutError(false))).toBe(
      JOB_FAILURE_CODE.TIMED_OUT,
    );
  });

  it("says nothing about what was running", () => {
    expect(new JobTimeoutError(true).message).toBe(
      "The job attempt exceeded its timeout.",
    );
  });
});

describe("the code vocabulary", () => {
  it("is closed and unique", () => {
    expect(new Set(JOB_FAILURE_CODES).size).toBe(JOB_FAILURE_CODES.length);
  });

  it("uses stable slugs rather than sentences", () => {
    for (const code of JOB_FAILURE_CODES) {
      expect(code, code).toMatch(/^[a-z][a-z-]*$/);
    }
  });
});
