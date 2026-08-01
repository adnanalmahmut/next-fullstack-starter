import "server-only";

import { AuthorizationAuditAction } from "@/generated/prisma/enums";
import { database } from "@/platform/database/index.server";

import { AUDIT_ACTION, type AuditAction } from "./audit-action";
import {
  type AuthorizationAuditWrite,
  type StoredAuditRecord,
} from "./audit-record";

/**
 * The only data-access point for the authorization audit trail.
 *
 * It exposes exactly two operations: append one record, and read the most recent
 * records. There is deliberately no update, no delete, and no unbounded read.
 *
 * The action column is a database enum whose labels are the application's stable
 * action names. Both directions of the mapping are exhaustive, so adding an
 * action without mapping it is a type error.
 */
const STORED_ACTION_BY_ACTION = {
  [AUDIT_ACTION.USER_ROLE_SET]: AuthorizationAuditAction.USER_ROLE_SET,
  [AUDIT_ACTION.SESSION_REVOKED]: AuthorizationAuditAction.SESSION_REVOKED,
} as const satisfies Readonly<Record<AuditAction, AuthorizationAuditAction>>;

const ACTION_BY_STORED_ACTION = {
  [AuthorizationAuditAction.USER_ROLE_SET]: AUDIT_ACTION.USER_ROLE_SET,
  [AuthorizationAuditAction.SESSION_REVOKED]: AUDIT_ACTION.SESSION_REVOKED,
} as const satisfies Readonly<Record<AuthorizationAuditAction, AuditAction>>;

/** Appends one record. The store never rewrites an existing row. */
export async function appendAuthorizationAuditRecord(
  record: AuthorizationAuditWrite,
): Promise<void> {
  await database.authorizationAuditRecord.create({
    data: {
      actorUserId: record.actorUserId,
      actorSessionId: record.actorSessionId,
      action: STORED_ACTION_BY_ACTION[record.action],
      targetUserId: record.targetUserId,
      requestId: record.requestId,
      ...(record.metadata ? { metadata: record.metadata } : {}),
    },
  });
}

/**
 * Reads the most recent records, newest first.
 *
 * The caller must pass an already-validated limit; the query is always bounded.
 * `actorSessionId` is not selected, because no reader is allowed to see it.
 */
export async function findRecentAuthorizationAuditRecords(
  limit: number,
): Promise<readonly StoredAuditRecord[]> {
  const rows = await database.authorizationAuditRecord.findMany({
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit,
    select: {
      id: true,
      occurredAt: true,
      action: true,
      actorUserId: true,
      targetUserId: true,
      requestId: true,
      metadata: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurredAt,
    action: ACTION_BY_STORED_ACTION[row.action],
    actorUserId: row.actorUserId,
    targetUserId: row.targetUserId,
    requestId: row.requestId,
    metadata: row.metadata,
  }));
}
