import { describe, expect, expectTypeOf, it } from "vitest";

import { ERROR_CODE } from "@/shared/errors/error-code";

import {
  HTTP_STATUS_BY_ERROR_CODE,
  httpStatusForError,
  type HttpErrorStatus,
} from "./http-response";

describe("HTTP error status mapping", () => {
  it("maps every error code to its conventional status", () => {
    expect(HTTP_STATUS_BY_ERROR_CODE).toEqual({
      VALIDATION_FAILED: 400,
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      RATE_LIMITED: 429,
      DEPENDENCY_UNAVAILABLE: 503,
      INTERNAL_ERROR: 500,
    });
  });

  it.each([
    [ERROR_CODE.VALIDATION_FAILED, 400],
    [ERROR_CODE.UNAUTHENTICATED, 401],
    [ERROR_CODE.FORBIDDEN, 403],
    [ERROR_CODE.NOT_FOUND, 404],
    [ERROR_CODE.CONFLICT, 409],
    [ERROR_CODE.RATE_LIMITED, 429],
    [ERROR_CODE.INTERNAL_ERROR, 500],
  ] as const)("returns the status for %s", (code, status) => {
    expect(httpStatusForError(code)).toBe(status);
    expectTypeOf(httpStatusForError(code)).toEqualTypeOf<HttpErrorStatus>();
  });
});
