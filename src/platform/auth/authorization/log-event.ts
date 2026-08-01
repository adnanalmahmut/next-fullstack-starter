/**
 * Stable log event names for authorization.
 *
 * They are language neutral identifiers, not user-facing text. A log line for
 * these events may carry an actor id, a target id, an action, a permission, a
 * request id, and a safe error code, and nothing else.
 */
export const AUTHORIZATION_LOG_EVENT = {
  ACCESS_DENIED: "authorization.access.denied",
  AUDIT_WRITE_FAILED: "authorization.audit.write_failed",
  ADMIN_OPERATION_COMPLETED: "authorization.admin.operation_completed",
} as const;

export type AuthorizationLogEvent =
  (typeof AUTHORIZATION_LOG_EVENT)[keyof typeof AUTHORIZATION_LOG_EVENT];
