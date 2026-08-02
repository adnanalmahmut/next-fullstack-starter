/**
 * The identifier shapes the audit trail accepts.
 *
 * Two of the columns hold values that came from somewhere else — a request
 * identifier resolved at the edge, a record identifier handed back in a cursor —
 * and both are re-checked here rather than trusted. The platform is the last
 * thing between a value and a durable row, and the database repeats the same
 * constraint underneath it.
 *
 * The pattern is canonical UUID rather than a specific version. It is
 * case-insensitive because the request-id header contract accepts either case,
 * and a stricter check here would refuse a value the edge already accepted.
 */
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && canonicalUuidPattern.test(value);
}

/** The width of a canonical UUID, and of the `requestId` column. */
export const MAX_AUDIT_REQUEST_ID_LENGTH = 36;

/**
 * Whether a value may be stored as the causing request identifier.
 *
 * Absence is normal and is stored as `null`: a change made by a scheduled task
 * or a console session had no request behind it, and inventing an identifier
 * would be worse than admitting there was none.
 */
export function isAuditRequestId(value: unknown): value is string {
  return isCanonicalUuid(value);
}

export const MAX_AUDIT_RESOURCE_ID_LENGTH = 255;

export function isAuditResourceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_AUDIT_RESOURCE_ID_LENGTH &&
    value.trim() === value
  );
}
