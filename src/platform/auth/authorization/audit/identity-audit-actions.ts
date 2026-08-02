import * as z from "zod";

import { defineAuditAction } from "@/platform/audit/index.server";

import { AUTHORIZATION_ROLE_NAMES } from "../role";

/**
 * The auditable identity actions, declared by the area that performs them.
 *
 * This is the whole point of the split. The audit platform holds no action of
 * its own and never will; an action belongs to whoever can actually perform it,
 * because that is the only place that knows what is worth recording about it and
 * what shape the detail takes. A documents module will declare
 * `documents.document.published` in its own directory, in its own pull request,
 * and the platform will not change.
 *
 * Both actions record a target user, so both use `identity.user` as the resource
 * type — including `identity.session.revoked`, whose name is grouped under
 * `session` but whose target has always been the user whose sessions were ended.
 * The resource type is not derived from the action name for exactly this reason.
 *
 * The names are unchanged from before the platform existed. They are in every
 * historical row that was copied into the new table, so changing one would
 * silently orphan the history it refers to.
 */
export const IDENTITY_AUDIT_RESOURCE_TYPE = "identity.user" as const;

export const IDENTITY_AUDIT_ACTION = {
  USER_ROLE_SET: "identity.user.role-set",
  SESSION_REVOKED: "identity.session.revoked",
} as const;

export type IdentityAuditAction =
  (typeof IDENTITY_AUDIT_ACTION)[keyof typeof IDENTITY_AUDIT_ACTION];

/** The revocation scope this application supports. */
export const IDENTITY_REVOKE_SCOPE = "all" as const;

/**
 * A completed role change.
 *
 * The metadata is the new role and nothing else. Not the previous role — that is
 * in the preceding record — and certainly not the target's name or address,
 * which the resource identifier already points at without copying them into a
 * durable field.
 */
export const userRoleSetAudit = defineAuditAction({
  name: IDENTITY_AUDIT_ACTION.USER_ROLE_SET,
  resourceType: IDENTITY_AUDIT_RESOURCE_TYPE,
  metadataSchema: z
    .object({
      role: z.enum(AUTHORIZATION_ROLE_NAMES),
    })
    .strict(),
});

/**
 * A completed session revocation.
 *
 * `scope` has one legal value today. It is recorded rather than left implicit so
 * that a future partial revocation is a new value in a closed set, not a
 * reinterpretation of every record already written.
 */
export const sessionRevokedAudit = defineAuditAction({
  name: IDENTITY_AUDIT_ACTION.SESSION_REVOKED,
  resourceType: IDENTITY_AUDIT_RESOURCE_TYPE,
  metadataSchema: z
    .object({
      scope: z.literal(IDENTITY_REVOKE_SCOPE),
    })
    .strict(),
});

/**
 * Every identity action, for a composition root building a catalog.
 *
 * Declaration order is the order a reader sees in documentation and in the
 * catalog's `names`.
 */
export const IDENTITY_AUDIT_ACTIONS = [
  userRoleSetAudit,
  sessionRevokedAudit,
] as const;
