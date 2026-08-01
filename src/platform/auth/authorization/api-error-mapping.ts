import { APIError, isAPIError } from "better-auth/api";

import {
  ApplicationError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  RateLimitedError,
  UnauthenticatedError,
  ValidationError,
} from "@/shared/errors/application-error";
import { ERROR_CODE, type ErrorCode } from "@/shared/errors/error-code";

/**
 * Translation between the application's typed errors and Better Auth's endpoint
 * error type.
 *
 * Better Auth endpoints are a transport of their own: they answer with an
 * `APIError`, and a hook that refuses a request has to speak that language. The
 * application layer speaks `ApplicationError`. These two functions are the only
 * place the two meet, so a status never has to be chosen twice.
 *
 * Neither direction copies a message across. A provider message is never shown
 * to a caller, and an internal diagnostic message is never serialized.
 */
const API_ERROR_STATUS_BY_CODE = {
  [ERROR_CODE.VALIDATION_FAILED]: "BAD_REQUEST",
  [ERROR_CODE.UNAUTHENTICATED]: "UNAUTHORIZED",
  [ERROR_CODE.FORBIDDEN]: "FORBIDDEN",
  [ERROR_CODE.NOT_FOUND]: "NOT_FOUND",
  [ERROR_CODE.CONFLICT]: "CONFLICT",
  [ERROR_CODE.RATE_LIMITED]: "TOO_MANY_REQUESTS",
  [ERROR_CODE.INTERNAL_ERROR]: "INTERNAL_SERVER_ERROR",
} as const satisfies Readonly<Record<ErrorCode, string>>;

/**
 * Converts an application error into the endpoint error Better Auth returns.
 *
 * Anything that is not a typed application error is left alone: it is an
 * unexpected failure, and hiding it behind a chosen status would remove it from
 * the logs.
 */
export function toApiError(error: unknown): unknown {
  if (!(error instanceof ApplicationError)) {
    return error;
  }

  return new APIError(API_ERROR_STATUS_BY_CODE[error.code], {
    code: error.code,
    message: "The administrative operation was refused.",
  });
}

const APPLICATION_ERROR_BY_STATUS_CODE = new Map<
  number,
  (message: string) => ApplicationError
>([
  [400, (message) => new ValidationError(message)],
  [401, (message) => new UnauthenticatedError(message)],
  [403, (message) => new ForbiddenError(message)],
  [404, (message) => new NotFoundError(message)],
  [409, (message) => new ConflictError(message)],
  [429, (message) => new RateLimitedError(message)],
]);

/**
 * Converts a caught value into a typed application error.
 *
 * An `APIError` with a status the application models becomes the matching typed
 * error. Everything else becomes `InternalError`, so a provider payload, a
 * database detail, or an unknown status can never travel further.
 */
export function toApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) {
    return error;
  }

  if (isAPIError(error)) {
    const create = APPLICATION_ERROR_BY_STATUS_CODE.get(error.statusCode);

    if (create) {
      return create(
        `Better Auth refused the operation with status ${error.statusCode}.`,
      );
    }
  }

  return new InternalError("An administrative operation failed unexpectedly.", {
    cause: error,
  });
}
