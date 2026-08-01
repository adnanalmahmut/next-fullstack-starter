import { APIError, isAPIError } from "better-auth/api";
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

import { toApiError, toApplicationError } from "./api-error-mapping";

describe("toApiError", () => {
  it.each([
    { error: new ValidationError("invalid"), status: 400 },
    { error: new UnauthenticatedError("no actor"), status: 401 },
    { error: new ForbiddenError("denied"), status: 403 },
    { error: new NotFoundError("absent"), status: 404 },
    { error: new ConflictError("conflict"), status: 409 },
    { error: new InternalError("broken"), status: 500 },
  ])("maps $error.code to status $status", ({ error, status }) => {
    const converted = toApiError(error);

    expect(isAPIError(converted)).toBe(true);
    expect((converted as APIError).statusCode).toBe(status);
    expect((converted as APIError).body?.code).toBe(error.code);
  });

  it("returns an unexpected value untouched so it stays visible", () => {
    const unexpected = new TypeError("boom");

    expect(toApiError(unexpected)).toBe(unexpected);
    expect(toApiError("plain")).toBe("plain");
  });

  it("never copies the internal diagnostic message", () => {
    const converted = toApiError(
      new ForbiddenError("internal detail about the last administrator"),
    );

    expect((converted as APIError).body?.message).not.toContain(
      "internal detail",
    );
  });
});

describe("toApplicationError", () => {
  it("returns an application error unchanged", () => {
    const error = new ConflictError("conflict");

    expect(toApplicationError(error)).toBe(error);
  });

  it.each([
    { status: "BAD_REQUEST", code: ERROR_CODE.VALIDATION_FAILED },
    { status: "UNAUTHORIZED", code: ERROR_CODE.UNAUTHENTICATED },
    { status: "FORBIDDEN", code: ERROR_CODE.FORBIDDEN },
    { status: "NOT_FOUND", code: ERROR_CODE.NOT_FOUND },
    { status: "CONFLICT", code: ERROR_CODE.CONFLICT },
  ] as const)("maps $status to $code", ({ status, code }) => {
    expect(toApplicationError(new APIError(status)).code).toBe(code);
  });

  it("maps an unmodelled status to an internal error", () => {
    expect(toApplicationError(new APIError("TOO_MANY_REQUESTS")).code).toBe(
      ERROR_CODE.INTERNAL_ERROR,
    );
    expect(toApplicationError(new APIError("INTERNAL_SERVER_ERROR")).code).toBe(
      ERROR_CODE.INTERNAL_ERROR,
    );
  });

  it("maps an unknown value to an internal error", () => {
    expect(toApplicationError(new TypeError("boom")).code).toBe(
      ERROR_CODE.INTERNAL_ERROR,
    );
    expect(toApplicationError("plain").code).toBe(ERROR_CODE.INTERNAL_ERROR);
    expect(toApplicationError(undefined).code).toBe(ERROR_CODE.INTERNAL_ERROR);
  });

  it("does not carry a provider message into the application error", () => {
    const error = toApplicationError(
      new APIError("FORBIDDEN", {
        message: "YOU_ARE_NOT_ALLOWED_TO_LIST_USERS",
      }),
    );

    expect(error.message).not.toContain("YOU_ARE_NOT_ALLOWED");
  });
});
