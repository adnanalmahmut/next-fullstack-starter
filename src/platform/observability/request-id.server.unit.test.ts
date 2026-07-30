import { describe, expect, it } from "vitest";

import {
  isValidRequestId,
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "./request-id.server";

const validRequestId = "123e4567-e89b-42d3-a456-426614174000";

describe("request ID", () => {
  it("uses the stable header name", () => {
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });

  it("retains a valid UUID v4", () => {
    expect(isValidRequestId(validRequestId)).toBe(true);
    expect(resolveRequestId(validRequestId)).toBe(validRequestId);
  });

  it.each([
    undefined,
    null,
    "",
    "not-a-uuid",
    "123e4567-e89b-12d3-a456-426614174000",
    `${validRequestId}${"x".repeat(256)}`,
    [validRequestId],
  ])("replaces an invalid or missing value: %j", (value) => {
    const resolved = resolveRequestId(value);

    expect(resolved).not.toBe(value);
    expect(isValidRequestId(resolved)).toBe(true);
  });

  it("generates independent values", () => {
    const first = resolveRequestId(undefined);
    const second = resolveRequestId(undefined);

    expect(first).not.toBe(second);
    expect(isValidRequestId(first)).toBe(true);
    expect(isValidRequestId(second)).toBe(true);
  });
});
