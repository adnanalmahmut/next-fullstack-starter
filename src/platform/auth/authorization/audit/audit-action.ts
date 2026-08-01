import { ADMIN_ROLE, USER_ROLE, isAuthorizationRole } from "../role";

/**
 * The closed set of administrative mutations this application audits.
 *
 * Reads are not audited. Only a mutation that actually changed state produces a
 * record, and every record is written exactly once.
 */
export const AUDIT_ACTION = {
  USER_ROLE_SET: "identity.user.role-set",
  SESSION_REVOKED: "identity.session.revoked",
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

export const AUDIT_ACTIONS: readonly AuditAction[] =
  Object.values(AUDIT_ACTION);

export function isAuditAction(value: unknown): value is AuditAction {
  return (
    typeof value === "string" &&
    (AUDIT_ACTIONS as readonly string[]).includes(value)
  );
}

/** The revocation scope this pull request supports. */
export const AUDIT_REVOKE_SCOPE = "all" as const;

/**
 * The allowlisted metadata shapes.
 *
 * Nothing else may ever be stored: no password, password hash, session token,
 * cookie, authorization header, email address, display name, IP address, user
 * agent, raw request body, raw provider error, or stack trace.
 */
export type AuditMetadata =
  | Readonly<{ role: typeof USER_ROLE | typeof ADMIN_ROLE }>
  | Readonly<{ scope: typeof AUDIT_REVOKE_SCOPE }>;

/** Builds the metadata for a completed role change. */
export function buildRoleSetMetadata(role: unknown): AuditMetadata | null {
  return isAuthorizationRole(role) ? { role } : null;
}

/** Builds the metadata for a completed session revocation. */
export function buildSessionRevokedMetadata(): AuditMetadata {
  return { scope: AUDIT_REVOKE_SCOPE };
}

/**
 * Reads metadata back from storage.
 *
 * Anything that does not match an allowlisted shape resolves to `null`, so a
 * value written by an older or unexpected code path can never reach a caller.
 */
export function parseAuditMetadata(value: unknown): AuditMetadata | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const keys = Object.keys(value);

  if (keys.length !== 1) {
    return null;
  }

  const record = value as Readonly<Record<string, unknown>>;

  if (keys[0] === "role") {
    return buildRoleSetMetadata(record.role);
  }

  if (keys[0] === "scope" && record.scope === AUDIT_REVOKE_SCOPE) {
    return { scope: AUDIT_REVOKE_SCOPE };
  }

  return null;
}
