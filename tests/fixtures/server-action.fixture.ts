"use server";

import * as z from "zod";

import {
  AUTHORIZATION_MODE,
  defineAction,
} from "@/platform/actions/index.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";

/**
 * Action definitions exactly as an application feature would write them.
 *
 * The fixture exists so the contract suite can assert the boundary against real
 * definitions without inventing a business module. Every export is an async
 * function, which is what the `"use server"` directive at the top of this file
 * requires: a definition file must not export a value that is not one.
 *
 * Note what is absent. No definition parses its own input, reads a session,
 * compares a role, evaluates a capability, maps an error to a code, builds an
 * `ActionResult`, or calls a cache API. All of that belongs to the factory, and a
 * definition that restated it would be duplicating the adapter.
 */
const executionLog: string[] = [];

/** An async reader, so the observation surface obeys the directive as well. */
export async function readActionExecutionLog(): Promise<readonly string[]> {
  return [...executionLog];
}

export async function clearActionExecutionLog(): Promise<void> {
  executionLog.length = 0;
}

/** A public read. `actor` is `null` and no session is consulted. */
export const readGreetingAction = defineAction({
  name: "fixture.greeting.read",
  input: z.object({ name: z.string().min(1) }),
  authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
  execute: ({ input }) => {
    executionLog.push("greeting.execute");

    return { greeting: `Hello, ${input.name}` };
  },
});

/**
 * A capability-protected mutation.
 *
 * The audit entry is an `afterSuccess` hook carrying allowlisted identifiers, and
 * the invalidated path is declared here rather than taken from the input.
 */
export const setFixtureRoleAction = defineAction({
  name: "fixture.identity.role-set",
  input: z.object({ userId: z.string().trim().min(1) }),
  authorization: {
    mode: AUTHORIZATION_MODE.PERMISSION,
    permission: PERMISSION.IDENTITY_USER_SET_ROLE,
  },
  execute: ({ input, actor }) => {
    executionLog.push("role-set.execute");

    return { targetUserId: input.userId, actorUserId: actor.userId };
  },
  hooks: {
    afterSuccess: [
      ({ output }) => {
        executionLog.push(`role-set.audit:${output.targetUserId}`);
      },
    ],
  },
  revalidate: { paths: [{ path: "/admin/users" }] },
});
