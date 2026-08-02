import type { AuditActorType } from "./audit-actor";
import type { AuditResult } from "./audit-result";

/**
 * The complete allowlist of fields an audit log line may carry.
 *
 * The temptation here is specific and strong: the line that says "the audit
 * record could not be written" is exactly the line where someone will want to
 * print the record, so it is not lost. That instinct is why the allowlist is
 * enforced by construction rather than by everyone remembering.
 *
 * Metadata never appears. It is the one field with an open shape, it is the
 * field the whole platform is careful about, and a log line is the least
 * protected place it could end up. Neither does the acting session identifier,
 * which is stored for investigation and read by nothing. Neither does the raw
 * error: an exception from a database driver carries the statement, the
 * parameters, and sometimes the connection string.
 *
 * What is left is what an operator actually needs to find the change that was
 * not recorded: which action, who did it, what it was done to, how it ended, and
 * a stable code for why the write failed.
 */
export type AuditLogFields = Readonly<{
  action?: string;
  actorType?: AuditActorType;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  result?: AuditResult;
  requestId?: string;
  errorCode?: string;
}>;

export type AuditLogInput = Readonly<{
  action?: string | undefined;
  actorType?: AuditActorType | undefined;
  actorId?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  result?: AuditResult | undefined;
  requestId?: string | null | undefined;
  errorCode?: string | undefined;
}>;

/**
 * The field names a line may carry, in one list.
 *
 * Exported so a contract test can assert that the allowlist and the documented
 * set are the same list rather than two lists that agree today.
 */
export const AUDIT_LOG_FIELD_NAMES = [
  "action",
  "actorType",
  "actorId",
  "resourceType",
  "resourceId",
  "result",
  "requestId",
  "errorCode",
] as const;

/**
 * Builds the payload for an audit event.
 *
 * Absent values are omitted rather than serialized as `null`, so a line never
 * claims to know something it does not, and anything the input carries beyond
 * the allowlist is dropped here rather than at each call site.
 */
export function toAuditLogFields(input: AuditLogInput): AuditLogFields {
  const source = input as Record<string, unknown>;
  const fields: Record<string, unknown> = {};

  for (const name of AUDIT_LOG_FIELD_NAMES) {
    const value = source[name];

    if (value !== undefined && value !== null) {
      fields[name] = value;
    }
  }

  return fields as AuditLogFields;
}
