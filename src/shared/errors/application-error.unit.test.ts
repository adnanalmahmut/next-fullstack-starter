import { describe, expect, it } from "vitest";

import {
  ApplicationError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "./application-error";
import { ERROR_CODE, type ErrorCode } from "./error-code";

type ApplicationErrorConstructor = new (
  message: string,
  options?: ErrorOptions,
) => ApplicationError;

const errorCases: ReadonlyArray<
  readonly [ApplicationErrorConstructor, ErrorCode]
> = [
  [ValidationError, ERROR_CODE.VALIDATION_FAILED],
  [UnauthenticatedError, ERROR_CODE.UNAUTHENTICATED],
  [ForbiddenError, ERROR_CODE.FORBIDDEN],
  [NotFoundError, ERROR_CODE.NOT_FOUND],
  [ConflictError, ERROR_CODE.CONFLICT],
  [InternalError, ERROR_CODE.INTERNAL_ERROR],
];

describe("application errors", () => {
  it.each(errorCases)(
    "constructs %s with its stable error code",
    (ErrorConstructor, code) => {
      const error = new ErrorConstructor("Internal diagnostic message");

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ApplicationError);
      expect(error).toBeInstanceOf(ErrorConstructor);
      expect(error.name).toBe(ErrorConstructor.name);
      expect(error.message).toBe("Internal diagnostic message");
      expect(error.code).toBe(code);
    },
  );

  it("preserves an intentional cause", () => {
    const cause = new Error("Low-level failure");
    const error = new InternalError("Operation failed", { cause });

    expect(error.cause).toBe(cause);
  });
});
