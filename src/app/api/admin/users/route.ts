import type { NextRequest } from "next/server";

import { getActorFromHeaders } from "@/platform/auth/authorization/actor.server";
import {
  parseAdminUsersQuery,
  toQueryRecord,
} from "@/platform/auth/authorization/admin-query";
import { listAdminUsers } from "@/platform/auth/authorization/admin-users.service.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { requirePermission } from "@/platform/auth/authorization/require-permission.server";
import { jsonError, jsonSuccess } from "@/platform/http/json-response";

/**
 * Lists users for the administration area.
 *
 * A Route Handler is a public entry point: it reads the session itself, requires
 * the capability itself, and validates its own query. It never assumes a layout,
 * a proxy redirect, or a downstream service has already decided anything.
 */
export async function GET(request: NextRequest) {
  try {
    const requestHeaders = request.headers;
    const actor = await requirePermission(
      await getActorFromHeaders(requestHeaders),
      PERMISSION.IDENTITY_USER_LIST,
    );
    const query = parseAdminUsersQuery(
      toQueryRecord(request.nextUrl.searchParams),
    );

    return jsonSuccess(
      await listAdminUsers({ actor, headers: requestHeaders }, query),
    );
  } catch (error) {
    return jsonError(error);
  }
}
