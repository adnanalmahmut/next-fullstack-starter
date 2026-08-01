import * as z from "zod";

import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { AUTHORIZATION_MODE, defineRoute } from "@/platform/http/index.server";

/**
 * Route definitions exactly as an application endpoint would write them.
 *
 * The fixture exists so the contract suite can assert the boundary against real
 * definitions without inventing a business module, and without importing the
 * administration routes and their Better Auth dependencies.
 *
 * Note what is absent. No definition reads a body, parses its own input, reads a
 * session, compares a role, evaluates a capability, maps an error to a code, or
 * builds a `Response`. All of that belongs to the factory, and a definition that
 * restated it would be duplicating the adapter.
 */
const executionLog: string[] = [];

export function readRouteExecutionLog(): readonly string[] {
  return [...executionLog];
}

export function clearRouteExecutionLog(): void {
  executionLog.length = 0;
}

/** A public read. `actor` is `null` and no session is consulted. */
export const GET_GREETING = defineRoute({
  name: "fixture.greeting.read",
  input: { query: z.object({ name: z.string().min(1) }) },
  authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
  execute: ({ query }) => {
    executionLog.push("greeting.execute");

    return { greeting: `Hello, ${query.name}` };
  },
});

/**
 * A capability-protected mutation.
 *
 * The target comes from the path and the value from the body, each with its own
 * schema. The audit entry is a declared hook carrying allowlisted identifiers.
 */
export const PATCH_ROLE = defineRoute({
  name: "fixture.identity.role-set",
  input: {
    params: z.object({ userId: z.string().trim().min(1) }),
    body: z.object({ role: z.string() }),
  },
  authorization: {
    mode: AUTHORIZATION_MODE.PERMISSION,
    permission: PERMISSION.IDENTITY_USER_SET_ROLE,
  },
  execute: ({ params, body, actor }) => {
    executionLog.push("role-set.execute");

    return {
      targetUserId: params.userId,
      role: body.role,
      actorUserId: actor.userId,
    };
  },
  hooks: {
    audit: [
      ({ output }) => {
        executionLog.push(`role-set.audit:${output.targetUserId}`);
      },
    ],
  },
});

/** A mutation with no payload. It answers `200` with a null envelope. */
export const POST_REVOKE = defineRoute({
  name: "fixture.identity.session-revoke",
  input: { params: z.object({ userId: z.string().trim().min(1) }) },
  authorization: {
    mode: AUTHORIZATION_MODE.PERMISSION,
    permission: PERMISSION.IDENTITY_SESSION_REVOKE,
  },
  execute: ({ params }) => {
    executionLog.push(`session-revoke.execute:${params.userId}`);

    return null;
  },
});
