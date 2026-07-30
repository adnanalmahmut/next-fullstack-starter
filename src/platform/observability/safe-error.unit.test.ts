import { describe, expect, it } from "vitest";

import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "@/shared/errors/application-error";
import { ERROR_CODE } from "@/shared/errors/error-code";

import {
  isExpectedApplicationError,
  LOG_ERROR_TYPE,
  toSafeLogError,
} from "./safe-error";

describe("safe log error", () => {
  it.each([
    [new ValidationError("diagnostic"), ERROR_CODE.VALIDATION_FAILED],
    [new UnauthenticatedError("diagnostic"), ERROR_CODE.UNAUTHENTICATED],
    [new ForbiddenError("diagnostic"), ERROR_CODE.FORBIDDEN],
    [new NotFoundError("diagnostic"), ERROR_CODE.NOT_FOUND],
    [new ConflictError("diagnostic"), ERROR_CODE.CONFLICT],
    [new InternalError("diagnostic"), ERROR_CODE.INTERNAL_ERROR],
  ])("keeps a known application error code", (error, code) => {
    expect(toSafeLogError(error)).toEqual({
      errorType: LOG_ERROR_TYPE.APPLICATION,
      errorCode: code,
    });
  });

  it.each([
    new Error("private message"),
    "private message",
    { message: "private message", code: "P2002" },
    null,
    undefined,
  ])("classifies an unknown value without exposing it", (value) => {
    const safeError = toSafeLogError(value);

    expect(safeError.errorCode).toBe(ERROR_CODE.INTERNAL_ERROR);
    expect(Object.keys(safeError).sort()).toEqual(["errorCode", "errorType"]);
    expect(JSON.stringify(safeError)).not.toContain("private message");
    expect(JSON.stringify(safeError)).not.toContain("P2002");
  });

  it("distinguishes unexpected Error instances from non-Error values", () => {
    expect(toSafeLogError(new Error("diagnostic")).errorType).toBe(
      LOG_ERROR_TYPE.UNEXPECTED,
    );
    expect(toSafeLogError("diagnostic").errorType).toBe(
      LOG_ERROR_TYPE.NON_ERROR,
    );
  });

  it("treats only non-internal application errors as expected", () => {
    expect(isExpectedApplicationError(new NotFoundError("diagnostic"))).toBe(
      true,
    );
    expect(isExpectedApplicationError(new InternalError("diagnostic"))).toBe(
      false,
    );
    expect(isExpectedApplicationError(new Error("diagnostic"))).toBe(false);
  });
});
