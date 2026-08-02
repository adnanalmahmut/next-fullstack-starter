/**
 * Stable log event names for the audit platform.
 *
 * There is one, and that is deliberate. A successful audit write already has a
 * record — writing a log line as well would duplicate the record in a place with
 * weaker retention and weaker guarantees, and it would be the noisiest line in
 * the system. What has no other trace, and therefore needs one, is the write
 * that did not happen.
 */
export const AUDIT_LOG_EVENT = {
  RECORD_WRITE_FAILED: "audit.record.write_failed",
} as const;

export type AuditLogEvent =
  (typeof AUDIT_LOG_EVENT)[keyof typeof AUDIT_LOG_EVENT];

export const AUDIT_LOG_EVENTS: readonly AuditLogEvent[] =
  Object.values(AUDIT_LOG_EVENT);
