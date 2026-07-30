import type { ErrorCode } from "@/shared/errors/error-code";

export type PublicError = Readonly<{
  code: ErrorCode;
}>;
