import * as z from "zod";

/**
 * Who performed an audited action.
 *
 * The contract is generic on purpose: it names a kind and an identifier, and
 * nothing else. It does not know what a session is beyond an opaque string, it
 * has never heard of Better Auth, and it carries no attribute that could be
 * mistaken for an authorization input.
 *
 * What it deliberately excludes is the whole reason it is a separate type from
 * the application's `Actor`: no email address, no display name, no role list, no
 * token, no cookie, no IP address, no user agent, no headers. An audit trail is
 * durable and is shown to administrators; every one of those would be a
 * disclosure that outlives the request that produced it. Roles in particular are
 * excluded twice over — recording the role an actor held would invite a reader
 * to reason about it, and this application never decides access from a role.
 *
 * `actorSessionId` is the one investigative field. It is stored so an incident
 * can be traced to a single sign-in, and it is never selected into a DTO, an API
 * response, or a rendered page.
 */
export const AUDIT_ACTOR_TYPE = {
  USER: "user",
  SYSTEM: "system",
} as const;

export type AuditActorType =
  (typeof AUDIT_ACTOR_TYPE)[keyof typeof AUDIT_ACTOR_TYPE];

export const AUDIT_ACTOR_TYPES: readonly AuditActorType[] =
  Object.values(AUDIT_ACTOR_TYPE);

export const MAX_AUDIT_ACTOR_ID_LENGTH = 255;
export const MAX_AUDIT_SESSION_ID_LENGTH = 255;

/**
 * A person acting through a session, or the application acting on its own.
 *
 * The two cases differ in exactly one field, and the difference is not
 * cosmetic: a user action can always be traced to a sign-in, and a system action
 * never can, because there was none. Making that a union rather than an optional
 * field means neither case can be written wrongly — a database constraint
 * repeats the same rule for anything that reaches the table another way.
 */
export type AuditActor =
  | Readonly<{
      type: typeof AUDIT_ACTOR_TYPE.USER;
      id: string;
      sessionId: string;
    }>
  | Readonly<{
      type: typeof AUDIT_ACTOR_TYPE.SYSTEM;
      id: string;
    }>;

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_AUDIT_ACTOR_ID_LENGTH);

const auditActorSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal(AUDIT_ACTOR_TYPE.USER),
      id: identifierSchema,
      sessionId: z.string().trim().min(1).max(MAX_AUDIT_SESSION_ID_LENGTH),
    })
    .strict(),
  z
    .object({
      type: z.literal(AUDIT_ACTOR_TYPE.SYSTEM),
      id: identifierSchema,
    })
    .strict(),
]);

/**
 * Validates an actor.
 *
 * `null` rather than a thrown error, so the two writers can each decide: the
 * transactional one refuses the whole transaction, the post-commit one records
 * the failure and lets the completed change stand.
 */
export function parseAuditActor(value: unknown): AuditActor | null {
  const result = auditActorSchema.safeParse(value);

  return result.success ? result.data : null;
}

export function isAuditActor(value: unknown): value is AuditActor {
  return parseAuditActor(value) !== null;
}

/** A person acting through a verified session. */
export function userAuditActor(id: string, sessionId: string): AuditActor {
  return { type: AUDIT_ACTOR_TYPE.USER, id, sessionId };
}

/**
 * The application acting on its own behalf.
 *
 * The identifier must be stable and meaningful — the name of the process or the
 * scheduled task — because it is the only thing a reader has to go on. A random
 * value would satisfy the type and tell nobody anything.
 */
export function systemAuditActor(id: string): AuditActor {
  return { type: AUDIT_ACTOR_TYPE.SYSTEM, id };
}

/** The session identifier to store, which exists only for a user actor. */
export function auditActorSessionId(actor: AuditActor): string | null {
  return actor.type === AUDIT_ACTOR_TYPE.USER ? actor.sessionId : null;
}
