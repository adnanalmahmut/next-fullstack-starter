import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import {
  AuditActorType as StoredActorType,
  AuditResult as StoredResult,
} from "@/generated/prisma/enums";
import { database } from "@/platform/database/index.server";
import {
  DATABASE_OPERATION,
  withDatabaseOperationSpan,
} from "@/platform/observability/database-span.server";

import { AUDIT_ACTOR_TYPE, type AuditActorType } from "./audit-actor";
import { auditActorSessionId } from "./audit-actor";
import type { AuditCursor } from "./audit-cursor";
import type { AuditRecordWrite, StoredAuditRecord } from "./audit-record";
import { AUDIT_RESULT, type AuditResult } from "./audit-result";

/**
 * The only data-access point for the audit trail.
 *
 * It exposes two operations: append one record, and read one bounded page. There
 * is deliberately no update, no delete, no upsert, no `deleteMany`, no truncate,
 * and no export. "Append-only" in this application means exactly that — the
 * capability does not exist in the code, so no call site can reach for it and no
 * review has to catch it. A contract test scans this directory and fails if a
 * mutation other than a create appears.
 *
 * It is not exported from `index.server.ts` either. The two writers and the one
 * reader are the public surface; handing out the repository would let a caller
 * bypass the metadata policy that the writers apply.
 *
 * Both enum columns are mapped explicitly in both directions. The mappings are
 * exhaustive by type, so adding a value on either side without mapping it is a
 * compile error rather than a row that cannot be read back.
 */
const STORED_ACTOR_TYPE = {
  [AUDIT_ACTOR_TYPE.USER]: StoredActorType.USER,
  [AUDIT_ACTOR_TYPE.SYSTEM]: StoredActorType.SYSTEM,
} as const satisfies Readonly<Record<AuditActorType, StoredActorType>>;

const ACTOR_TYPE_BY_STORED = {
  [StoredActorType.USER]: AUDIT_ACTOR_TYPE.USER,
  [StoredActorType.SYSTEM]: AUDIT_ACTOR_TYPE.SYSTEM,
} as const satisfies Readonly<Record<StoredActorType, AuditActorType>>;

const STORED_RESULT = {
  [AUDIT_RESULT.SUCCEEDED]: StoredResult.SUCCEEDED,
  [AUDIT_RESULT.FAILED]: StoredResult.FAILED,
  [AUDIT_RESULT.DENIED]: StoredResult.DENIED,
} as const satisfies Readonly<Record<AuditResult, StoredResult>>;

const RESULT_BY_STORED = {
  [StoredResult.SUCCEEDED]: AUDIT_RESULT.SUCCEEDED,
  [StoredResult.FAILED]: AUDIT_RESULT.FAILED,
  [StoredResult.DENIED]: AUDIT_RESULT.DENIED,
} as const satisfies Readonly<Record<StoredResult, AuditResult>>;

/**
 * The client an append runs on.
 *
 * A transaction client for the transactional writer, the singleton for the
 * post-commit one. The repository does not care which it was handed; deciding
 * that a caller must be inside a transaction is a policy the transactional
 * writer enforces, and putting it here would make the post-commit path
 * impossible.
 */
export type AuditWriteClient = Prisma.TransactionClient;

/** Appends one record. The store never rewrites an existing row. */
export async function insertAuditRecord(
  client: AuditWriteClient,
  record: AuditRecordWrite,
): Promise<string> {
  const row = await withDatabaseOperationSpan(
    DATABASE_OPERATION.AUDIT_APPEND,
    () =>
      client.auditRecord.create({
        data: {
          actorType: STORED_ACTOR_TYPE[record.actor.type],
          actorId: record.actor.id,
          actorSessionId: auditActorSessionId(record.actor),
          action: record.action,
          resourceType: record.resourceType,
          resourceId: record.resourceId,
          result: STORED_RESULT[record.result],
          requestId: record.requestId,
          ...(record.metadata === null
            ? {}
            : { metadata: record.metadata as Prisma.InputJsonValue }),
          ...(record.occurredAt === undefined
            ? {}
            : { occurredAt: record.occurredAt }),
        },
        select: { id: true },
      }),
  );

  return row.id;
}

/**
 * Reads one bounded, newest-first page.
 *
 * The ordering is `occurredAt DESC, id DESC`, and the identifier is not
 * decoration: two records written in the same millisecond would otherwise have
 * no defined order between them, and a keyset page across that boundary would
 * repeat one and skip the other. The same pair is the index, and the same pair
 * is the cursor.
 *
 * The keyset predicate is the row-value comparison `(occurredAt, id) <
 * (cursor.occurredAt, cursor.id)`, spelled out as an `OR` because that is what
 * Prisma can express. It is strict, so the cursor row itself is never returned
 * twice.
 *
 * `actorSessionId` is not selected. Not filtered out afterwards, not selected —
 * so it cannot reach a caller even by accident.
 */
export async function findAuditRecordPage(
  limit: number,
  cursor: AuditCursor | null,
): Promise<readonly StoredAuditRecord[]> {
  const rows = await withDatabaseOperationSpan(
    DATABASE_OPERATION.AUDIT_LIST,
    () =>
      database.auditRecord.findMany({
        ...(cursor === null
          ? {}
          : {
              where: {
                OR: [
                  { occurredAt: { lt: cursor.occurredAt } },
                  { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
                ],
              },
            }),
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: limit,
        select: {
          id: true,
          occurredAt: true,
          actorType: true,
          actorId: true,
          action: true,
          resourceType: true,
          resourceId: true,
          result: true,
          requestId: true,
          metadata: true,
        },
      }),
  );

  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurredAt,
    actorType: ACTOR_TYPE_BY_STORED[row.actorType],
    actorId: row.actorId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    result: RESULT_BY_STORED[row.result],
    requestId: row.requestId,
    metadata: row.metadata,
  }));
}
