import "server-only";

import { ForbiddenError } from "@/shared/errors/application-error";
import { getRequestLogger } from "@/platform/observability/logger.server";

import { auth } from "../auth.server";

import { type Actor } from "./actor";
import { requireActor } from "./actor.server";
import { AUTHORIZATION_LOG_EVENT } from "./log-event";
import {
  type Permission,
  type PermissionRequest,
  toPermissionRequest,
} from "./permission-registry";

/**
 * The centralized capability gate.
 *
 * Every protected page, Route Handler, and server service goes through one of
 * these three functions. They never compare a role name: the decision is made by
 * Better Auth, using the actor's verified user id, so the role is read from the
 * database rather than taken from a session snapshot or from request input.
 *
 * A permission that is not declared in the registry, and an empty request, both
 * fail closed: the request cannot be built, so nothing is granted.
 */
export type NonEmptyPermissions = readonly [Permission, ...Permission[]];

/**
 * Not exported on purpose. A boolean capability answer belongs either to a
 * `require*` helper or to `resolveAuthorization`, so a call site cannot quietly
 * check a capability and then ignore the result.
 */
async function hasPermission(
  actor: Actor,
  request: PermissionRequest | null,
): Promise<boolean> {
  if (!request) {
    return false;
  }

  const result = await auth.api.userHasPermission({
    body: {
      userId: actor.userId,
      permissions: request,
    },
  });

  return result.success === true;
}

function denied(actor: Actor, permissions: readonly Permission[]): never {
  getRequestLogger().warn(
    {
      userId: actor.userId,
      actorType: "user",
      permission: permissions.join(" "),
    },
    AUTHORIZATION_LOG_EVENT.ACCESS_DENIED,
  );

  throw new ForbiddenError("The actor does not hold the required capability.");
}

/** Requires one capability. */
export async function requirePermission(
  actor: Actor | null | undefined,
  permission: Permission,
): Promise<Actor> {
  return requireAllPermissions(actor, [permission]);
}

/** Requires at least one of the listed capabilities. */
export async function requireAnyPermission(
  actor: Actor | null | undefined,
  permissions: NonEmptyPermissions,
): Promise<Actor> {
  const presentActor = requireActor(actor);

  for (const permission of permissions) {
    if (await hasPermission(presentActor, toPermissionRequest([permission]))) {
      return presentActor;
    }
  }

  return denied(presentActor, permissions);
}

/** Requires every listed capability. */
export async function requireAllPermissions(
  actor: Actor | null | undefined,
  permissions: NonEmptyPermissions,
): Promise<Actor> {
  const presentActor = requireActor(actor);

  if (await hasPermission(presentActor, toPermissionRequest(permissions))) {
    return presentActor;
  }

  return denied(presentActor, permissions);
}

export const AUTHORIZATION_OUTCOME = {
  GRANTED: "granted",
  UNAUTHENTICATED: "unauthenticated",
  FORBIDDEN: "forbidden",
} as const;

export type AuthorizationOutcome =
  (typeof AUTHORIZATION_OUTCOME)[keyof typeof AUTHORIZATION_OUTCOME];

/**
 * The non-throwing form, for a Server Component that has to render a state
 * instead of failing.
 *
 * It evaluates exactly the same capability through exactly the same path as
 * `requireAllPermissions`; the only difference is that the answer is returned.
 * Every mutation and every API entry point uses the throwing form.
 */
export async function resolveAuthorization(
  actor: Actor | null | undefined,
  permissions: NonEmptyPermissions,
): Promise<AuthorizationOutcome> {
  if (!actor) {
    return AUTHORIZATION_OUTCOME.UNAUTHENTICATED;
  }

  if (await hasPermission(actor, toPermissionRequest(permissions))) {
    return AUTHORIZATION_OUTCOME.GRANTED;
  }

  getRequestLogger().warn(
    {
      userId: actor.userId,
      actorType: "user",
      permission: permissions.join(" "),
    },
    AUTHORIZATION_LOG_EVENT.ACCESS_DENIED,
  );

  return AUTHORIZATION_OUTCOME.FORBIDDEN;
}
