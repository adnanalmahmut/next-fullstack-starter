import { describe, expect, it } from "vitest";

import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "@/shared/errors/application-error";
import { ERROR_CODE, type ErrorCode } from "@/shared/errors/error-code";

import { toPublicError } from "./to-public-error";

const knownErrors: ReadonlyArray<readonly [Error, ErrorCode]> = [
  [
    new ValidationError("Invalid application input"),
    ERROR_CODE.VALIDATION_FAILED,
  ],
  [
    new UnauthenticatedError("No actor is available"),
    ERROR_CODE.UNAUTHENTICATED,
  ],
  [new ForbiddenError("The actor lacks permission"), ERROR_CODE.FORBIDDEN],
  [new NotFoundError("The entity was not found"), ERROR_CODE.NOT_FOUND],
  [new ConflictError("The entity already exists"), ERROR_CODE.CONFLICT],
  [new InternalError("The operation failed"), ERROR_CODE.INTERNAL_ERROR],
];

describe("toPublicError", () => {
  it.each(knownErrors)(
    "preserves a known application error code",
    (error, code) => {
      expect(toPublicError(error)).toEqual({ code });
    },
  );

  it.each([
    new Error("Unexpected failure"),
    "Unexpected failure",
    { code: ERROR_CODE.NOT_FOUND, message: "Untrusted object" },
    null,
    undefined,
  ])("normalizes an unknown value to INTERNAL_ERROR", (error) => {
    expect(toPublicError(error)).toEqual({
      code: ERROR_CODE.INTERNAL_ERROR,
    });
  });

  it("returns only the public error code", () => {
    const cause = new Error("Database connection details");
    const error = new NotFoundError("Internal diagnostic message", { cause });
    const publicError = toPublicError(error);

    expect(Object.keys(publicError)).toEqual(["code"]);
    expect(publicError).not.toHaveProperty("message");
    expect(publicError).not.toHaveProperty("stack");
    expect(publicError).not.toHaveProperty("cause");
  });
});
