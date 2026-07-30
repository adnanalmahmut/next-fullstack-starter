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

export class InternalError extends ApplicationError {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODE.INTERNAL_ERROR, message, options);
  }
}
