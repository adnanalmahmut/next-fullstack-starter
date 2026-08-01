import { normalizeRoles } from "./role";

/**
 * The normalized server-side view of whoever is making a request.
 *
 * The shape is deliberately narrow. It carries no session token, cookie, IP
 * address, user agent, password or account data, ban metadata, and no resolved
 * permission graph. `roles` is descriptive context for logging and audit
 * reasoning, never the basis of a decision: capabilities are always evaluated
 * through the permission registry.
 */
export type Actor = {
  readonly userId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly email: string;
  readonly roles: readonly string[];
};

/**
 * The subset of a Better Auth session this module reads. Declaring it locally
 * keeps the normalization pure and testable without a live auth instance.
 */
export type ActorSource = {
  readonly session: {
    readonly id: string;
    readonly userId: string;
  };
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly role?: unknown;
  };
};

/**
 * Builds an actor from a session that the server has already verified.
 *
 * A caller must never assemble this from request input: the role is read from
 * the verified session's user record, so a client cannot present one.
 */
export function toActor(source: ActorSource | null | undefined): Actor | null {
  if (!source) {
    return null;
  }

  return {
    userId: source.user.id,
    sessionId: source.session.id,
    name: source.user.name,
    email: source.user.email,
    roles: normalizeRoles(source.user.role),
  };
}
