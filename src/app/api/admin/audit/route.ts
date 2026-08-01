import type { NextRequest } from "next/server";

import { getActorFromHeaders } from "@/platform/auth/authorization/actor.server";
import { listAuthorizationAudit } from "@/platform/auth/authorization/admin-audit.service.server";
import {
  parseAdminAuditQuery,
  toQueryRecord,
} from "@/platform/auth/authorization/admin-query";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { requirePermission } from "@/platform/auth/authorization/require-permission.server";
import { jsonError, jsonSuccess } from "@/platform/http/json-response";

/**
 * Lists the most recent authorization audit records.
 *
 * Reading the audit trail needs its own capability, and the page is bounded. There
 * is no endpoint that updates, deletes, or exports a record.
 */
export async function GET(request: NextRequest) {
  try {
    const requestHeaders = request.headers;
    const actor = await requirePermission(
      await getActorFromHeaders(requestHeaders),
      PERMISSION.IDENTITY_AUDIT_READ,
    );
    const query = parseAdminAuditQuery(
      toQueryRecord(request.nextUrl.searchParams),
    );

    return jsonSuccess(
      await listAuthorizationAudit({ actor, headers: requestHeaders }, query),
    );
  } catch (error) {
    return jsonError(error);
  }
}
