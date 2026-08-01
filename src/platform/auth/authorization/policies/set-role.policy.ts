import {
  ConflictError,
  ForbiddenError,
  ValidationError,
} from "@/shared/errors/application-error";

import { ADMIN_ROLE, isAuthorizationRole } from "../role";

/**
 * The resource-level decision for changing a user's role.
 *
 * A capability answers "may this actor change roles at all". This policy answers
 * "may this actor change *this* record, in its current state". It is pure: it
 * receives already-loaded facts and never reads a session, a request, or the
 * database.
 */
export type SetRolePolicyInput = Readonly<{
  actorUserId: string;
  targetUserId: string;
  /** The target's currently stored roles, already normalized. */
  targetRoles: readonly string[];
  /** The single role requested by the caller, still untrusted. */
  requestedRole: unknown;
  /**
   * How many *other* users hold the admin role. The target is excluded, so the
   * check does not have to reason about whether it counted itself.
   */
  otherAdminCount: number;
}>;

/**
 * Throws unless the role change is allowed.
 *
 * Order matters, because it decides which failure a caller observes:
 *
 * 1. An unapproved role value is invalid input.
 * 2. Removing the admin role from the only remaining administrator conflicts with
 *    the current state of the system.
 * 3. Changing your own role is refused outright, so an administrator cannot
 *    escalate themselves or drop out of the area by accident.
 *
 * The conflict is checked before the self check on purpose. Only an
 * administrator holds the capability to change a role, so the only way to reach
 * the last administrator as a target is to be that administrator. Answering
 * "you are the last administrator" is both the accurate reason and the more
 * useful one; a self change that is not the last administrator still stops at
 * step 3.
 */
export function assertSetRoleAllowed(input: SetRolePolicyInput): void {
  if (!isAuthorizationRole(input.requestedRole)) {
    throw new ValidationError(
      "The requested role is not one of the approved roles.",
    );
  }

  const targetIsAdmin = input.targetRoles.includes(ADMIN_ROLE);
  const removesAdmin = input.requestedRole !== ADMIN_ROLE;

  if (targetIsAdmin && removesAdmin && input.otherAdminCount < 1) {
    throw new ConflictError(
      "The last remaining administrator cannot lose the admin role.",
    );
  }

  if (input.actorUserId === input.targetUserId) {
    throw new ForbiddenError("An actor cannot change its own role.");
  }
}
