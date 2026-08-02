/**
 * How an audited attempt ended.
 *
 * The set is closed and matches a database enum one for one, so a value that is
 * not one of these cannot be stored and cannot come back from storage.
 *
 * A word on what this application currently records. Only completed
 * administrative changes are audited, and they are recorded as `succeeded`.
 * `failed` and `denied` exist because the contract belongs to the platform
 * rather than to its first caller, and a module that wants to record a refusal
 * should not have to migrate an enum to do it. They are not evidence that every
 * refusal in the system is written down: there is no global failure auditing
 * here, deliberately, because a record written on every denial turns the audit
 * trail into an access log and buries the changes it exists to show.
 */
export const AUDIT_RESULT = {
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  DENIED: "denied",
} as const;

export type AuditResult = (typeof AUDIT_RESULT)[keyof typeof AUDIT_RESULT];

export const AUDIT_RESULTS: readonly AuditResult[] =
  Object.values(AUDIT_RESULT);

export function isAuditResult(value: unknown): value is AuditResult {
  return (
    typeof value === "string" &&
    (AUDIT_RESULTS as readonly string[]).includes(value)
  );
}
