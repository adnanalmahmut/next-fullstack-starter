/**
 * Role names and role normalization.
 *
 * This file and `../access-control.ts` are the only places allowed to name a
 * role. Everywhere else an authorization decision is made through a capability
 * permission, never by comparing a role name.
 *
 * Better Auth stores a role as a single column and represents multiple roles as
 * a comma separated list, so reading a role always means parsing that shape.
 */

export const USER_ROLE = "user";
export const ADMIN_ROLE = "admin";

/** The closed set of roles this application assigns. */
export const AUTHORIZATION_ROLE_NAMES = [USER_ROLE, ADMIN_ROLE] as const;

export type AuthorizationRole = (typeof AUTHORIZATION_ROLE_NAMES)[number];

/** The role Better Auth assigns when a user is created. */
export const DEFAULT_ROLE: AuthorizationRole = USER_ROLE;

/** Roles Better Auth treats as administrative for its own plugin checks. */
export const ADMIN_ROLES: readonly AuthorizationRole[] = [ADMIN_ROLE];

export function isAuthorizationRole(
  value: unknown,
): value is AuthorizationRole {
  return (
    typeof value === "string" &&
    (AUTHORIZATION_ROLE_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Normalizes a stored role column into a stable list.
 *
 * Entries are trimmed, empty entries are dropped, and duplicates collapse. An
 * unrecognized entry is kept so the value stays an honest description of what is
 * stored; it grants nothing, because the capability evaluator only finds
 * statements for a declared role.
 *
 * A missing or blank column produces an empty list. Better Auth applies its
 * configured default role in that case, and that default holds no
 * administrative capability.
 */
export function normalizeRoles(value: unknown): readonly string[] {
  if (typeof value !== "string") {
    return [];
  }

  const roles = new Set<string>();

  for (const entry of value.split(",")) {
    const role = entry.trim();

    if (role.length > 0) {
      roles.add(role);
    }
  }

  return [...roles];
}
