/**
 * Stable log event names for authorization.
 *
 * They are language neutral identifiers, not user-facing text. A log line for
 * these events may carry an actor id, a target id, an action, a permission, a
 * request id, and a safe error code, and nothing else.
 *
 * A failed audit write is not among them any more. It is the audit platform's
 * event now — `audit.record.write_failed` — because the trail is no longer
 * authorization's, and two events for one failure would mean an operator had to
 * know which subsystem happened to be writing.
 */
export const AUTHORIZATION_LOG_EVENT = {
  ACCESS_DENIED: "authorization.access.denied",
  ADMIN_OPERATION_COMPLETED: "authorization.admin.operation_completed",
} as const;

export type AuthorizationLogEvent =
  (typeof AUTHORIZATION_LOG_EVENT)[keyof typeof AUTHORIZATION_LOG_EVENT];
