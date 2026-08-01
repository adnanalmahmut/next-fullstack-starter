import type { PublicError } from "@/platform/errors/public-error";
import { ERROR_CODE, type ErrorCode } from "@/shared/errors/error-code";

export type HttpSuccessResponse<T> = Readonly<{
  data: T;
}>;

export type HttpErrorResponse<E extends PublicError = PublicError> = Readonly<{
  error: E;
}>;

export type HttpResponse<T, E extends PublicError = PublicError> =
  HttpSuccessResponse<T> | HttpErrorResponse<E>;

export type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;

export const HTTP_STATUS_BY_ERROR_CODE = {
  [ERROR_CODE.VALIDATION_FAILED]: 400,
  [ERROR_CODE.UNAUTHENTICATED]: 401,
  [ERROR_CODE.FORBIDDEN]: 403,
  [ERROR_CODE.NOT_FOUND]: 404,
  [ERROR_CODE.CONFLICT]: 409,
  [ERROR_CODE.RATE_LIMITED]: 429,
  // 503 rather than 500: the request was refused before anything ran, so it is
  // safe to retry, which is precisely what 503 says and 500 does not.
  [ERROR_CODE.DEPENDENCY_UNAVAILABLE]: 503,
  [ERROR_CODE.INTERNAL_ERROR]: 500,
} as const satisfies Record<ErrorCode, HttpErrorStatus>;

export function httpStatusForError(code: ErrorCode): HttpErrorStatus {
  return HTTP_STATUS_BY_ERROR_CODE[code];
}

/**
 * The statuses a route may answer with on success.
 *
 * The set is closed and a route names its own member statically, so a status can
 * never be chosen by client input or returned by a use case.
 */
export type HttpSuccessStatus = 200 | 201;

export const HTTP_SUCCESS_STATUS = {
  OK: 200,
  CREATED: 201,
} as const satisfies Record<string, HttpSuccessStatus>;
