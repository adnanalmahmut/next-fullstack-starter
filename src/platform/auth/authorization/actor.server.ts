import "server-only";

import { headers } from "next/headers";

import { UnauthenticatedError } from "@/shared/errors/application-error";

import { getSessionFromHeaders } from "../session.server";

import { type Actor, toActor } from "./actor";

/**
 * Reads the actor for an explicit header set.
 *
 * Every call reaches the database through Better Auth, so a cookie alone proves
 * nothing and a revoked session resolves to `null` immediately.
 */
export async function getActorFromHeaders(
  requestHeaders: Headers,
): Promise<Actor | null> {
  return toActor(await getSessionFromHeaders(requestHeaders));
}

/** Reads the actor for the current Server Component or Route Handler request. */
export async function getCurrentActor(): Promise<Actor | null> {
  return getActorFromHeaders(await headers());
}

/** Narrows an optional actor, refusing an unauthenticated caller. */
export function requireActor(actor: Actor | null | undefined): Actor {
  if (!actor) {
    throw new UnauthenticatedError(
      "The operation requires an authenticated actor.",
    );
  }

  return actor;
}
