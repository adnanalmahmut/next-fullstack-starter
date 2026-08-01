import type { NextRequest } from "next/server";

import { getActorFromHeaders } from "@/platform/auth/authorization/actor.server";
import { parseTargetUserId } from "@/platform/auth/authorization/admin-query";
import { revokeAdminUserSessions } from "@/platform/auth/authorization/admin-users.service.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { requirePermission } from "@/platform/auth/authorization/require-permission.server";
import { jsonError, jsonNoContent } from "@/platform/http/json-response";

type AdminUserSessionsRouteContext = {
  params: Promise<{
    userId: string;
  }>;
};

/**
 * Revokes every session of the target user.
 *
 * The subject is a user identifier taken from the path. A session token supplied
 * by a caller is never accepted, and revoking the acting administrator's own
 * sessions through this operation is refused by the resource policy.
 */
export async function POST(
  request: NextRequest,
  context: AdminUserSessionsRouteContext,
) {
  try {
    const requestHeaders = request.headers;
    const actor = await requirePermission(
      await getActorFromHeaders(requestHeaders),
      PERMISSION.IDENTITY_SESSION_REVOKE,
    );
    const targetUserId = parseTargetUserId((await context.params).userId);

    await revokeAdminUserSessions(
      { actor, headers: requestHeaders },
      targetUserId,
    );

    return jsonNoContent();
  } catch (error) {
    return jsonError(error);
  }
}
