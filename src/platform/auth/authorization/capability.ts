import { findAuthorizationRole } from "../access-control";

import {
  type Permission,
  type PermissionRequest,
  toPermissionRequest,
} from "./permission-registry";
import { DEFAULT_ROLE } from "./role";

/**
 * Capability evaluation against the declared access control roles.
 *
 * This mirrors the semantics Better Auth applies inside the Admin plugin:
 *
 * - A user may hold several roles; holding the capability through any one of
 *   them is enough.
 * - Within a single role, every requested resource and action must be granted.
 * - A blank role column falls back to the configured default role.
 * - An unrecognized role, an undeclared permission, and an empty request all
 *   grant nothing.
 *
 * It is used where the verified role is already in hand, such as inside a Better
 * Auth hook. Application entry points go through the `require*` helpers, which
 * ask Better Auth itself and therefore read the role from the database.
 */
export function authorizeCapabilities(
  roles: readonly string[],
  request: PermissionRequest | null,
): boolean {
  if (!request) {
    return false;
  }

  const effectiveRoles = roles.length > 0 ? roles : [DEFAULT_ROLE];

  return effectiveRoles.some(
    (role) => findAuthorizationRole(role)?.authorize(request).success === true,
  );
}

/** Convenience form for flat permission names. */
export function hasCapabilities(
  roles: readonly string[],
  permissions: readonly Permission[],
): boolean {
  return authorizeCapabilities(roles, toPermissionRequest(permissions));
}
