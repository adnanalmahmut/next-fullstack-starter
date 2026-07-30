import { ApplicationError } from "@/shared/errors/application-error";
import { ERROR_CODE, type ErrorCode } from "@/shared/errors/error-code";

export const LOG_ERROR_TYPE = {
  APPLICATION: "application",
  UNEXPECTED: "unexpected",
  NON_ERROR: "non-error",
} as const;

export type SafeLogError = Readonly<{
  errorType: (typeof LOG_ERROR_TYPE)[keyof typeof LOG_ERROR_TYPE];
  errorCode: ErrorCode;
}>;

export function toSafeLogError(error: unknown): SafeLogError {
  if (error instanceof ApplicationError) {
    return {
      errorType: LOG_ERROR_TYPE.APPLICATION,
      errorCode: error.code,
    };
  }

  return {
    errorType:
      error instanceof Error
        ? LOG_ERROR_TYPE.UNEXPECTED
        : LOG_ERROR_TYPE.NON_ERROR,
    errorCode: ERROR_CODE.INTERNAL_ERROR,
  };
}

export function isExpectedApplicationError(error: unknown): boolean {
  return (
    error instanceof ApplicationError &&
    error.code !== ERROR_CODE.INTERNAL_ERROR
  );
}
