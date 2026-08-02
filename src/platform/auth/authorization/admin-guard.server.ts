import "server-only";

import {
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import * as z from "zod";

import { AUDIT_RESULT } from "@/platform/audit/index.server";
import {
  isValidRequestId,
  REQUEST_ID_HEADER,
} from "@/platform/observability/request-id.server";
import {
  ForbiddenError,
  UnauthenticatedError,
  ValidationError,
} from "@/shared/errors/application-error";

import { toActor } from "./actor";
import {
  ADMIN_ENDPOINT,
  findAdminEndpointRule,
  isAdminEndpointPath,
  isSelfScopedAdminEndpointPath,
} from "./admin-endpoints";
import { toApiError } from "./api-error-mapping";
import {
  IDENTITY_AUDIT_ACTION,
  IDENTITY_REVOKE_SCOPE,
  sessionRevokedAudit,
  userRoleSetAudit,
} from "./audit/identity-audit-actions";
import { toAuditActor } from "./audit/identity-audit-actor";
import { recordIdentityAudit } from "./audit/record-identity-audit.server";
import { hasCapabilities } from "./capability";
import {
  countOtherAdmins,
  findUserRoleById,
} from "./identity-read.repository.server";
import { assertRevokeSessionsAllowed } from "./policies/revoke-sessions.policy";
import { assertSetRoleAllowed } from "./policies/set-role.policy";
import { AUTHORIZATION_ROLE_NAMES, normalizeRoles } from "./role";

/**
 * The guard that makes the Better Auth Admin endpoints obey this application's
 * authorization rules.
 *
 * Better Auth runs `hooks.before` and `hooks.after` for a router request and for
 * a direct `auth.api.*` call alike, so one guard covers both. That is why the
 * application services simply call `auth.api.setRole` and
 * `auth.api.revokeUserSessions`: the capability check, the resource policy, and
 * the audit record are applied here, once, and cannot be skipped by calling
 * `/api/auth/admin/...` directly.
 *
 * The order is fixed, and it is the order that prevents an object-level
 * disclosure:
 *
 * 1. Authenticate the actor.
 * 2. Require the application capability for the endpoint.
 * 3. Validate the target identifier and the requested value.
 * 4. Load the target.
 * 5. Apply the resource policy.
 * 6. Let the endpoint execute.
 *
 * Because the capability is required before the target is loaded, a caller
 * without the capability is refused whether or not the target exists. A missing
 * target is deliberately left to the endpoint, so this hook never turns a
 * refusal into a "not found".
 */
const targetUserSchema = z.object({
  userId: z.string().trim().min(1).max(255),
});

const setRoleSchema = z.object({
  userId: z.string().trim().min(1).max(255),
  role: z.enum(AUTHORIZATION_ROLE_NAMES),
});

function parseOrRefuse<TOutput>(
  schema: z.ZodType<TOutput>,
  body: unknown,
): TOutput {
  const result = schema.safeParse(body);

  if (!result.success) {
    throw new ValidationError(
      "The administrative request body is not acceptable.",
    );
  }

  return result.data;
}

type AdminGuardContext = Parameters<typeof getAuthoritativeSessionFromCtx>[0];

function readRequestId(headers: Headers | undefined): string | null {
  const value = headers?.get(REQUEST_ID_HEADER);

  return value && isValidRequestId(value) ? value : null;
}

async function requireAdminActor(ctx: AdminGuardContext, path: string) {
  const rule = findAdminEndpointRule(path);

  if (!rule) {
    throw new ForbiddenError(
      "The administrative endpoint is not supported by this application.",
    );
  }

  const actor = toActor(await getAuthoritativeSessionFromCtx(ctx));

  if (!actor) {
    throw new UnauthenticatedError(
      "The administrative endpoint requires an authenticated actor.",
    );
  }

  if (!hasCapabilities(actor.roles, [rule.permission])) {
    throw new ForbiddenError(
      "The actor does not hold the capability for this administrative endpoint.",
    );
  }

  return { rule, actor };
}

async function guardAdminEndpoint(ctx: AdminGuardContext): Promise<void> {
  const path = ctx.path;

  if (!isAdminEndpointPath(path) || isSelfScopedAdminEndpointPath(path)) {
    return;
  }

  const { actor } = await requireAdminActor(ctx, path);

  if (path === ADMIN_ENDPOINT.SET_ROLE) {
    const input = parseOrRefuse(setRoleSchema, ctx.body);
    const target = await findUserRoleById(input.userId);

    if (!target) {
      // The endpoint owns the "not found" answer, so an unauthorized caller and
      // an authorized one cannot be told apart by probing identifiers.
      return;
    }

    assertSetRoleAllowed({
      actorUserId: actor.userId,
      targetUserId: target.id,
      targetRoles: normalizeRoles(target.role),
      requestedRole: input.role,
      otherAdminCount: await countOtherAdmins(target.id),
    });

    return;
  }

  if (path === ADMIN_ENDPOINT.REVOKE_USER_SESSIONS) {
    const input = parseOrRefuse(targetUserSchema, ctx.body);

    assertRevokeSessionsAllowed({
      actorUserId: actor.userId,
      targetUserId: input.userId,
    });
  }
}

function isSuccessfulReturn(returned: unknown): boolean {
  return (
    returned !== undefined &&
    returned !== null &&
    !isAPIError(returned) &&
    typeof returned === "object"
  );
}

async function auditAdminMutation(ctx: AdminGuardContext): Promise<void> {
  const path = ctx.path;
  const rule = findAdminEndpointRule(path);

  if (!rule?.audit || !isSuccessfulReturn(ctx.context.returned)) {
    return;
  }

  const actor = toActor(await getAuthoritativeSessionFromCtx(ctx));

  if (!actor) {
    return;
  }

  const requestId = readRequestId(ctx.headers);
  // Reduced here rather than passed through: an audit record may hold an actor's
  // identifiers and nothing else, and the projection is what enforces that.
  const auditActor = toAuditActor(actor);

  if (rule.audit === IDENTITY_AUDIT_ACTION.USER_ROLE_SET) {
    const input = parseOrRefuse(setRoleSchema, ctx.body);

    await recordIdentityAudit(userRoleSetAudit, {
      actor: auditActor,
      resourceId: input.userId,
      result: AUDIT_RESULT.SUCCEEDED,
      requestId,
      metadata: { role: input.role },
    });

    return;
  }

  const input = parseOrRefuse(targetUserSchema, ctx.body);

  await recordIdentityAudit(sessionRevokedAudit, {
    actor: auditActor,
    resourceId: input.userId,
    result: AUDIT_RESULT.SUCCEEDED,
    requestId,
    metadata: { scope: IDENTITY_REVOKE_SCOPE },
  });
}

/**
 * Hooks for the Better Auth instance.
 *
 * A refusal is translated into Better Auth's own error type so a direct caller
 * receives the correct status. An unexpected failure is rethrown untouched, so it
 * is logged rather than disguised as a chosen status.
 */
export const authorizationAdminHooks = {
  before: createAuthMiddleware(async (ctx) => {
    try {
      await guardAdminEndpoint(ctx);
    } catch (error) {
      throw toApiError(error);
    }
  }),

  after: createAuthMiddleware(async (ctx) => {
    await auditAdminMutation(ctx);
  }),
};
