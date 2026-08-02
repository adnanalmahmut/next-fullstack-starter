import { type AuditActor, userAuditActor } from "@/platform/audit/index.server";

import type { Actor } from "../actor";

/**
 * Narrows a verified actor down to what an audit record may hold.
 *
 * The conversion is one way and it is lossy on purpose. `Actor` carries a name,
 * an email address, and a role list, because a request handler legitimately
 * needs them; an audit record must carry none of them, because it is durable and
 * is shown to administrators long after the request is gone.
 *
 * Writing it as an explicit projection rather than a spread is what makes that
 * hold over time: a field added to `Actor` later does not silently start being
 * written to the audit trail, it simply is not passed here.
 *
 * This is also the one direction the dependency may run. Authentication knows
 * about the audit platform; the audit platform has never heard of Better Auth,
 * of `Actor`, or of this file.
 */
export function toAuditActor(actor: Actor): AuditActor {
  return userAuditActor(actor.userId, actor.sessionId);
}
