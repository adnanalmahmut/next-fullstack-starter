import type { Actor } from "./actor";
import type { Permission } from "./permission-registry";
import type { NonEmptyPermissions } from "./require-permission.server";

/**
 * The closed set of authorization modes a server entry point may declare.
 *
 * Both adapters that stand in front of a use case — the Server Action factory and
 * the Route Handler factory — describe their requirement with these modes, so a
 * capability means the same thing whether it is reached through a form submission
 * or through the HTTP API. The declaration lives here, in the authorization
 * module, rather than in either adapter: a second copy would be a second place to
 * change when a mode is added, and the two could drift apart without failing to
 * compile.
 *
 * There is no "skip" and no escape hatch: an entry point either declares itself
 * public or names what the caller must hold. A permission is always a registry
 * identifier, so an undeclared capability string cannot be requested, and the two
 * multi-permission modes take a non-empty tuple, so an empty list cannot be
 * mistaken for "no requirement".
 */
export const AUTHORIZATION_MODE = {
  PUBLIC: "public",
  ACTOR: "actor",
  PERMISSION: "permission",
  ANY_PERMISSION: "any-permission",
  ALL_PERMISSIONS: "all-permissions",
} as const;

export type AuthorizationMode =
  (typeof AUTHORIZATION_MODE)[keyof typeof AUTHORIZATION_MODE];

export const AUTHORIZATION_MODES: readonly AuthorizationMode[] =
  Object.values(AUTHORIZATION_MODE);

/** No session is required. `execute` reads `actor` as `null`. */
export type PublicAuthorization = Readonly<{
  mode: typeof AUTHORIZATION_MODE.PUBLIC;
}>;

/** A verified session is required, with no capability beyond being signed in. */
export type ActorAuthorization = Readonly<{
  mode: typeof AUTHORIZATION_MODE.ACTOR;
}>;

/** The caller must hold this one capability. */
export type PermissionAuthorization = Readonly<{
  mode: typeof AUTHORIZATION_MODE.PERMISSION;
  permission: Permission;
}>;

/** The caller must hold at least one of these capabilities. */
export type AnyPermissionAuthorization = Readonly<{
  mode: typeof AUTHORIZATION_MODE.ANY_PERMISSION;
  permissions: NonEmptyPermissions;
}>;

/** The caller must hold every one of these capabilities. */
export type AllPermissionsAuthorization = Readonly<{
  mode: typeof AUTHORIZATION_MODE.ALL_PERMISSIONS;
  permissions: NonEmptyPermissions;
}>;

export type Authorization =
  | PublicAuthorization
  | ActorAuthorization
  | PermissionAuthorization
  | AnyPermissionAuthorization
  | AllPermissionsAuthorization;

/**
 * The actor type `execute` and the hooks observe, derived from the declared mode.
 *
 * A public entry point reads `null`; every other mode reads a guaranteed `Actor`.
 * The use case therefore never has to re-check whether a caller is signed in, and
 * it cannot accidentally treat a public entry point as an authenticated one.
 */
export type AuthorizedActor<TAuthorization extends Authorization> =
  TAuthorization["mode"] extends typeof AUTHORIZATION_MODE.PUBLIC
    ? null
    : Actor;
