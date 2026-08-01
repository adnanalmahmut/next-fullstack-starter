import type * as z from "zod";

import type { ActionResult } from "@/platform/actions/action-result";
import type { Actor } from "@/platform/auth/authorization/actor";
import type { Permission } from "@/platform/auth/authorization/permission-registry";
import type { NonEmptyPermissions } from "@/platform/auth/authorization/require-permission.server";

import type { ActionContext } from "./action-context";
import type { ActionHooks } from "./action-hooks";
import type { CacheInvalidation } from "./cache-invalidation.server";

/**
 * The closed set of authorization modes a Server Action may declare.
 *
 * There is no "skip" and no escape hatch: an Action either declares itself public
 * or names what the caller must hold. A permission is always a registry
 * identifier, so an undeclared capability string cannot be requested, and the
 * two multi-permission modes take a non-empty tuple, so an empty list cannot be
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

export type ActionAuthorization =
  | PublicAuthorization
  | ActorAuthorization
  | PermissionAuthorization
  | AnyPermissionAuthorization
  | AllPermissionsAuthorization;

/**
 * The actor type `execute` and the hooks observe, derived from the declared mode.
 *
 * A public Action reads `null`; every other mode reads a guaranteed `Actor`. The
 * use case therefore never has to re-check whether a caller is signed in, and it
 * cannot accidentally treat a public Action as an authenticated one.
 */
export type ActionActor<TAuthorization extends ActionAuthorization> =
  TAuthorization["mode"] extends typeof AUTHORIZATION_MODE.PUBLIC
    ? null
    : Actor;

/**
 * The use case call.
 *
 * It is the only place business logic belongs. By the time it runs, the input is
 * validated and transformed, the actor is resolved, and the capability is
 * granted; it must not repeat any of that and must not touch the transport.
 */
export type ActionExecute<TInput, TActor, TOutput> = (
  context: ActionContext<TInput, TActor>,
) => TOutput | Promise<TOutput>;

/**
 * One Server Action declaration.
 *
 * `TOutput` is inferred from `execute`, and the input type is inferred from the
 * Zod schema's output, so a definition never restates a type the schema or the
 * use case already determines.
 */
export type ActionDefinition<
  TSchema extends z.ZodType,
  TAuthorization extends ActionAuthorization,
  TOutput,
> = Readonly<{
  /** A stable identifier such as `catalog.product.create`. Logged verbatim. */
  name: string;
  input: TSchema;
  authorization: TAuthorization;
  execute: ActionExecute<
    z.output<TSchema>,
    ActionActor<TAuthorization>,
    TOutput
  >;
  hooks?: ActionHooks<z.output<TSchema>, ActionActor<TAuthorization>, TOutput>;
  /**
   * Paths and tags to invalidate after the use case succeeds. Declared here and
   * never taken from client input.
   */
  revalidate?: CacheInvalidation;
}>;

/**
 * The callable a definition produces.
 *
 * It accepts `unknown` because a Server Action's argument crosses the network and
 * is untrusted until the schema has parsed it. It resolves rather than throws:
 * every outcome is an `ActionResult`.
 */
export type ServerAction<TOutput> = (
  input: unknown,
) => Promise<ActionResult<TOutput>>;
