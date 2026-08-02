import { createAccessControl } from "better-auth/plugins/access";
import type { Role } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";

import { APPLICATION_STATEMENTS } from "./authorization/permission-registry";
import { ADMIN_ROLE, USER_ROLE } from "./authorization/role";

/**
 * Access control for the Better Auth Admin plugin.
 *
 * The statements combine two sources:
 *
 * - The Admin plugin's own `user` and `session` statements, which decide whether
 *   its built-in endpoints run at all.
 * - The application's capability statements, declared once in the permission
 *   registry, which decide whether an application entry point runs.
 *
 * No business resource is invented here. Feature permissions such as catalog or
 * order actions belong to the module that owns them, in the pull request that
 * introduces it.
 */
export const authorizationStatements = {
  ...defaultStatements,
  ...APPLICATION_STATEMENTS,
} as const;

export const accessControl = createAccessControl(authorizationStatements);

/**
 * `user` is granted nothing. Every statement is listed with an empty action set
 * so the intent is explicit rather than inferred from an omission.
 */
export const userRole = accessControl.newRole({
  user: [],
  session: [],
  "identity.admin": [],
  "identity.user": [],
  "identity.session": [],
  "audit.record": [],
});

/**
 * `admin` is least privilege, not the plugin's full `adminAc`.
 *
 * Only the Better Auth operations this application actually performs are
 * granted. Creating, updating, deleting, banning, impersonating, changing a
 * password, and changing an email address are all withheld, so those endpoints
 * refuse an administrator as well.
 */
export const adminRole = accessControl.newRole({
  user: ["list", "get", "set-role"],
  session: ["list", "revoke"],
  "identity.admin": ["access"],
  "identity.user": ["list", "read", "set-role"],
  "identity.session": ["revoke"],
  "audit.record": ["read"],
});

export const authorizationRoles = {
  [USER_ROLE]: userRole,
  [ADMIN_ROLE]: adminRole,
};

/**
 * Looks up a role definition by its stored name.
 *
 * An unrecognized name resolves to `undefined`, which the capability evaluator
 * treats as granting nothing.
 */
export function findAuthorizationRole(role: string): Role | undefined {
  return Object.hasOwn(authorizationRoles, role)
    ? (authorizationRoles as Readonly<Record<string, Role>>)[role]
    : undefined;
}
