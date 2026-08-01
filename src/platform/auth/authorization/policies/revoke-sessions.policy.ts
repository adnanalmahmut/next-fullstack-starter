import { ForbiddenError } from "@/shared/errors/application-error";

/**
 * The resource-level decision for revoking every session of a target user.
 *
 * The target is identified by user id only. A session token supplied by a caller
 * is never accepted as the subject of this operation, and the acting identity is
 * never read from a request body or query string.
 */
export type RevokeSessionsPolicyInput = Readonly<{
  actorUserId: string;
  targetUserId: string;
}>;

/**
 * Throws unless revoking every session of the target is allowed.
 *
 * Revoking your own sessions through the target-user operation is refused: it
 * would sign the administrator out as a side effect of an administrative action.
 * Self-service session management is a separate feature with its own flow.
 */
export function assertRevokeSessionsAllowed(
  input: RevokeSessionsPolicyInput,
): void {
  if (input.actorUserId === input.targetUserId) {
    throw new ForbiddenError(
      "An actor cannot revoke its own sessions through the target-user operation.",
    );
  }
}
