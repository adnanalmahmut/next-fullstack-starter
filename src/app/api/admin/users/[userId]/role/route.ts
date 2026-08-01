import type { NextRequest } from "next/server";

import { getActorFromHeaders } from "@/platform/auth/authorization/actor.server";
import {
  parseSetRoleBody,
  parseTargetUserId,
} from "@/platform/auth/authorization/admin-query";
import { setAdminUserRole } from "@/platform/auth/authorization/admin-users.service.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { requirePermission } from "@/platform/auth/authorization/require-permission.server";
import { jsonError, jsonSuccess } from "@/platform/http/json-response";
import { ValidationError } from "@/shared/errors/application-error";

type AdminUserRoleRouteContext = {
  params: Promise<{
    userId: string;
  }>;
};

async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError("The request body is not valid JSON.");
  }
}

/**
 * Replaces a user's role with a single approved role.
 *
 * The target comes from the path, never from the body, and the acting identity
 * comes from the verified session, never from input. Whether the change is
 * allowed for this record is a resource-policy decision applied inside the Better
 * Auth guard, which also records the audit entry.
 */
export async function PATCH(
  request: NextRequest,
  context: AdminUserRoleRouteContext,
) {
  try {
    const requestHeaders = request.headers;
    const actor = await requirePermission(
      await getActorFromHeaders(requestHeaders),
      PERMISSION.IDENTITY_USER_SET_ROLE,
    );
    const targetUserId = parseTargetUserId((await context.params).userId);
    const body = parseSetRoleBody(await readJsonBody(request));

    return jsonSuccess(
      await setAdminUserRole(
        { actor, headers: requestHeaders },
        targetUserId,
        body.role,
      ),
    );
  } catch (error) {
    return jsonError(error);
  }
}
