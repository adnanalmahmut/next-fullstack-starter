export const ERROR_CODE = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  /**
   * A capability the caller's request genuinely required was not reachable.
   *
   * It is distinct from `INTERNAL_ERROR` because it is not a defect and it is
   * not permanent: the request was refused rather than attempted, nothing was
   * written, and the same request may succeed later. That is exactly what a
   * client needs to know to decide whether retrying is safe.
   */
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];
