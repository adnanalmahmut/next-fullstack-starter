/**
 * The single registry of application capability permissions.
 *
 * A permission name is always `<module>.<resource>.<action>`. The flat name is
 * what application code refers to; Better Auth evaluates a resource/action pair,
 * so the registry owns the translation between the two forms.
 *
 * Rules enforced here and asserted by the contract suite:
 *
 * - Every permission is declared exactly once, in this file.
 * - There is no wildcard permission and no dynamic permission string.
 * - A name that is not declared can never be granted.
 * - A permission never carries a role name.
 */

/**
 * Capability statements owned by the application, keyed by the Better Auth
 * resource. These are additive to the Admin plugin's own `user` and `session`
 * statements, which stay under Better Auth's ownership.
 */
export const APPLICATION_STATEMENTS = {
  "identity.admin": ["access"],
  "identity.user": ["list", "read", "set-role"],
  "identity.session": ["revoke"],
  "identity.audit": ["read"],
} as const;

export type PermissionResource = keyof typeof APPLICATION_STATEMENTS;

type FlatPermissionNames<
  TStatements extends Readonly<Record<string, readonly string[]>>,
> = {
  [
    Resource in keyof TStatements & string
  ]: `${Resource}.${TStatements[Resource][number]}`;
}[keyof TStatements & string];

/** Every permission this application can check. */
export type Permission = FlatPermissionNames<typeof APPLICATION_STATEMENTS>;

/**
 * Named constants for call sites. Permission literals must not appear outside
 * this file, so every consumer refers to a member of this object.
 */
export const PERMISSION = {
  IDENTITY_ADMIN_ACCESS: "identity.admin.access",
  IDENTITY_USER_LIST: "identity.user.list",
  IDENTITY_USER_READ: "identity.user.read",
  IDENTITY_USER_SET_ROLE: "identity.user.set-role",
  IDENTITY_SESSION_REVOKE: "identity.session.revoke",
  IDENTITY_AUDIT_READ: "identity.audit.read",
} as const satisfies Readonly<Record<string, Permission>>;

export type PermissionDefinition = Readonly<{
  resource: PermissionResource;
  action: string;
}>;

/**
 * The explicit flat-name to resource/action mapping. It is declared rather than
 * derived so a reader can see the whole surface at once; the contract suite
 * proves it agrees with `APPLICATION_STATEMENTS` in both directions.
 */
const PERMISSION_DEFINITIONS = {
  [PERMISSION.IDENTITY_ADMIN_ACCESS]: {
    resource: "identity.admin",
    action: "access",
  },
  [PERMISSION.IDENTITY_USER_LIST]: {
    resource: "identity.user",
    action: "list",
  },
  [PERMISSION.IDENTITY_USER_READ]: {
    resource: "identity.user",
    action: "read",
  },
  [PERMISSION.IDENTITY_USER_SET_ROLE]: {
    resource: "identity.user",
    action: "set-role",
  },
  [PERMISSION.IDENTITY_SESSION_REVOKE]: {
    resource: "identity.session",
    action: "revoke",
  },
  [PERMISSION.IDENTITY_AUDIT_READ]: {
    resource: "identity.audit",
    action: "read",
  },
} as const satisfies Readonly<Record<Permission, PermissionDefinition>>;

/** Declaration order is the documented order and is asserted by contract. */
export const PERMISSIONS: readonly Permission[] = Object.values(PERMISSION);

export function isPermission(value: unknown): value is Permission {
  return (
    typeof value === "string" &&
    Object.hasOwn(PERMISSION_DEFINITIONS, value) &&
    (PERMISSIONS as readonly string[]).includes(value)
  );
}

export function findPermissionDefinition(
  value: unknown,
): PermissionDefinition | null {
  return isPermission(value) ? PERMISSION_DEFINITIONS[value] : null;
}

/** The shape Better Auth's permission evaluation expects. */
export type PermissionRequest = Readonly<Record<string, readonly string[]>>;

/**
 * Builds one Better Auth permission request from flat permission names.
 *
 * Actions are grouped per resource, which is exactly the "all of these"
 * semantics Better Auth applies by default. `null` means the request cannot be
 * built and therefore must never be granted: an empty list and an undeclared
 * name both fail closed here rather than at the call site.
 */
export function toPermissionRequest(
  permissions: readonly Permission[],
): PermissionRequest | null {
  if (permissions.length === 0) {
    return null;
  }

  const actionsByResource = new Map<string, Set<string>>();

  for (const permission of permissions) {
    const definition = findPermissionDefinition(permission);

    if (!definition) {
      return null;
    }

    const actions =
      actionsByResource.get(definition.resource) ?? new Set<string>();

    actions.add(definition.action);
    actionsByResource.set(definition.resource, actions);
  }

  return Object.fromEntries(
    [...actionsByResource].map(([resource, actions]) => [
      resource,
      [...actions],
    ]),
  );
}
