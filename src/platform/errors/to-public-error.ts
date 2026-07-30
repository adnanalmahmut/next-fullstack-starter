import { ApplicationError } from "@/shared/errors/application-error";
import { ERROR_CODE } from "@/shared/errors/error-code";

import type { PublicError } from "./public-error";

export function toPublicError(error: unknown): PublicError {
  if (error instanceof ApplicationError) {
    return { code: error.code };
  }

  return { code: ERROR_CODE.INTERNAL_ERROR };
}
