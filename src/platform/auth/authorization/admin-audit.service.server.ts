import "server-only";

import type { AdminAuditQuery } from "./admin-query";
import type { AdminOperationContext } from "./admin-users.service.server";
import {
  type AuthorizationAuditRecordDto,
  toAuditRecordDtos,
} from "./audit/audit-record";
import { findRecentAuthorizationAuditRecords } from "./audit/audit-repository.server";
import { PERMISSION } from "./permission-registry";
import { requirePermission } from "./require-permission.server";

/**
 * The read side of the audit trail.
 *
 * Reading requires its own capability, the page is always bounded, and the result
 * is newest first. There is no counterpart that updates, deletes, or exports a
 * record.
 */
export type AuthorizationAuditPage = Readonly<{
  records: readonly AuthorizationAuditRecordDto[];
  limit: number;
}>;

export async function listAuthorizationAudit(
  context: AdminOperationContext,
  query: AdminAuditQuery,
): Promise<AuthorizationAuditPage> {
  await requirePermission(context.actor, PERMISSION.IDENTITY_AUDIT_READ);

  const records = await findRecentAuthorizationAuditRecords(query.limit);

  return {
    records: toAuditRecordDtos(records),
    limit: query.limit,
  };
}
