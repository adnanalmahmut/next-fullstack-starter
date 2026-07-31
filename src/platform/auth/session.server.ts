import "server-only";

import { headers } from "next/headers";

import { auth } from "./auth.server";

export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

/**
 * The minimal, client-safe view of an authenticated visitor.
 *
 * Session tokens, IP addresses, user agents, ban metadata, and role permission
 * graphs are deliberately excluded so a presentation boundary cannot leak them.
 */
export type SessionViewer = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
};

/**
 * Reads the session for an explicit header set.
 *
 * Route Handlers and integration tests use this form. Every call reaches the
 * database through Better Auth: no cookie cache is enabled, so a revoked session
 * is rejected immediately and a cookie alone proves nothing.
 */
export async function getSessionFromHeaders(
  requestHeaders: Headers,
): Promise<AuthSession> {
  return auth.api.getSession({
    headers: requestHeaders,
  });
}

/** Reads the session for the current Server Component request. */
export async function getCurrentSession(): Promise<AuthSession> {
  return getSessionFromHeaders(await headers());
}

export function toSessionViewer(session: AuthSession): SessionViewer | null {
  if (!session) {
    return null;
  }

  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
  };
}
