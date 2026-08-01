import type { NextRequest } from "next/server";

import { getActorFromHeaders } from "@/platform/auth/authorization/actor.server";
import { parseTargetUserId } from "@/platform/auth/authorization/admin-query";
import { getAdminUser } from "@/platform/auth/authorization/admin-users.service.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { requirePermission } from "@/platform/auth/authorization/require-permission.server";
import { jsonError, jsonSuccess } from "@/platform/http/json-response";

type AdminUserRouteContext = {
  params: Promise<{
    userId: string;
  }>;
};

/**
 * Reads one user.
 *
 * The capability is required before the target identifier is even validated, so a
 * caller without it cannot learn whether an identifier exists. An authorized
 * caller receives a genuine `404` for a missing user.
 */
export async function GET(
  request: NextRequest,
  context: AdminUserRouteContext,
) {
  try {
    const requestHeaders = request.headers;
    const actor = await requirePermission(
      await getActorFromHeaders(requestHeaders),
      PERMISSION.IDENTITY_USER_READ,
    );
    const targetUserId = parseTargetUserId((await context.params).userId);

    return jsonSuccess(
      await getAdminUser({ actor, headers: requestHeaders }, targetUserId),
    );
  } catch (error) {
    return jsonError(error);
  }
}
