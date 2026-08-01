import { AUDIT_ACTION, type AuditAction } from "./audit/audit-action";
import { PERMISSION, type Permission } from "./permission-registry";

/**
 * The Better Auth Admin plugin endpoints this application supports.
 *
 * These paths are reachable directly under `/api/auth`, so protecting the
 * application's own `/api/admin` routes is not enough. The guard hook uses this
 * table as an allowlist: an admin path that is not listed here is refused, which
 * keeps the surface closed by construction, including for endpoints a future
 * Better Auth version might add.
 *
 * The least-privilege role already withholds every operation outside this list.
 * The allowlist is the second, independent layer.
 */
export const ADMIN_ENDPOINT_PREFIX = "/admin/";

export const ADMIN_ENDPOINT = {
  LIST_USERS: "/admin/list-users",
  GET_USER: "/admin/get-user",
  SET_ROLE: "/admin/set-role",
  REVOKE_USER_SESSIONS: "/admin/revoke-user-sessions",
  HAS_PERMISSION: "/admin/has-permission",
} as const;

export type AdminEndpointRule = Readonly<{
  path: string;
  /** The application capability the caller must hold. */
  permission: Permission;
  /** The audit action a successful call produces, when it mutates state. */
  audit: AuditAction | null;
}>;

export const ADMIN_ENDPOINT_RULES: readonly AdminEndpointRule[] = [
  {
    path: ADMIN_ENDPOINT.LIST_USERS,
    permission: PERMISSION.IDENTITY_USER_LIST,
    audit: null,
  },
  {
    path: ADMIN_ENDPOINT.GET_USER,
    permission: PERMISSION.IDENTITY_USER_READ,
    audit: null,
  },
  {
    path: ADMIN_ENDPOINT.SET_ROLE,
    permission: PERMISSION.IDENTITY_USER_SET_ROLE,
    audit: AUDIT_ACTION.USER_ROLE_SET,
  },
  {
    path: ADMIN_ENDPOINT.REVOKE_USER_SESSIONS,
    permission: PERMISSION.IDENTITY_SESSION_REVOKE,
    audit: AUDIT_ACTION.SESSION_REVOKED,
  },
];

/**
 * Endpoints that only ever report on the caller itself.
 *
 * `/admin/has-permission` answers for the session that made the request, and
 * Better Auth refuses it outright when a request carries no valid session. The
 * application's own capability helpers call it without headers, so requiring a
 * capability here would make every capability check recursive.
 */
export const SELF_SCOPED_ADMIN_ENDPOINTS: readonly string[] = [
  ADMIN_ENDPOINT.HAS_PERMISSION,
];

export function isAdminEndpointPath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith(ADMIN_ENDPOINT_PREFIX);
}

export function isSelfScopedAdminEndpointPath(path: unknown): boolean {
  return typeof path === "string" && SELF_SCOPED_ADMIN_ENDPOINTS.includes(path);
}

export function findAdminEndpointRule(
  path: unknown,
): AdminEndpointRule | undefined {
  return typeof path === "string"
    ? ADMIN_ENDPOINT_RULES.find((rule) => rule.path === path)
    : undefined;
}
