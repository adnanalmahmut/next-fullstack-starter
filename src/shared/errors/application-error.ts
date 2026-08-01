import { ERROR_CODE, type ErrorCode } from "./error-code";

export abstract class ApplicationError extends Error {
  readonly code: ErrorCode;

  protected constructor(
    code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends ApplicationError {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODE.VALIDATION_FAILED, message, options);
  }
}

export class UnauthenticatedError extends ApplicationError {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODE.UNAUTHENTICATED, message, options);
  }
}

export class ForbiddenError extends ApplicationError {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODE.FORBIDDEN, message, options);
  }
}

export class NotFoundError extends ApplicationError {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODE.NOT_FOUND, message, options);
  }
}

export class ConflictError extends ApplicationError {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODE.CONFLICT, message, options);
  }
}

/**
 * The caller sent more requests than a limiter allows.
 *
 * It exists because the Route Handler factory's rate-limit extension point has to
 * be able to refuse a request with an answer a client can act on. No limiter is
 * implemented yet; a refusal can currently only come from a hook a definition
 * supplies.
 */
export class RateLimitedError extends ApplicationError {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODE.RATE_LIMITED, message, options);
  }
}

/**
 * A capability the request required could not be reached.
 *
 * It is thrown only where a caller has explicitly declared that it cannot
 * proceed without that capability — a `required` idempotency scope, a `required`
 * lock, a rate limiter whose fallback is `deny`. A caller that declared
 * `best-effort` never produces this: it degrades instead.
 *
 * The distinction matters because the refusal is safe. The use case did not run,
 * so nothing was written, and a client may retry the identical request.
 */
export class DependencyUnavailableError extends ApplicationError {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODE.DEPENDENCY_UNAVAILABLE, message, options);
  }
}

export class InternalError extends ApplicationError {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODE.INTERNAL_ERROR, message, options);
  }
}
