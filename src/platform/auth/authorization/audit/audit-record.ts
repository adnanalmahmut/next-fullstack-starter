import {
  type AuditAction,
  type AuditMetadata,
  isAuditAction,
  parseAuditMetadata,
} from "./audit-action";

/**
 * What the application asks the store to append.
 *
 * The record is append-only: there is no update or delete counterpart, and it
 * deliberately carries no foreign key, so it survives the removal of the user it
 * refers to.
 */
export type AuthorizationAuditWrite = Readonly<{
  actorUserId: string;
  actorSessionId: string;
  action: AuditAction;
  targetUserId: string;
  requestId: string | null;
  metadata: AuditMetadata | null;
}>;

/**
 * What a reader receives.
 *
 * `actorSessionId` is stored for investigation but is not part of this contract:
 * a session identifier has no place in a response or a rendered page.
 */
export type AuthorizationAuditRecordDto = Readonly<{
  id: string;
  occurredAt: string;
  action: AuditAction;
  actorUserId: string;
  targetUserId: string;
  requestId: string | null;
  metadata: AuditMetadata | null;
}>;

/** The stored row shape this module maps from. */
export type StoredAuditRecord = Readonly<{
  id: string;
  occurredAt: Date;
  action: string;
  actorUserId: string;
  targetUserId: string;
  requestId: string | null;
  metadata: unknown;
}>;

/**
 * Maps a stored row to the reader contract.
 *
 * An unrecognized action means the row cannot be presented safely, so it is
 * dropped rather than passed through.
 */
export function toAuditRecordDto(
  record: StoredAuditRecord,
): AuthorizationAuditRecordDto | null {
  if (!isAuditAction(record.action)) {
    return null;
  }

  return {
    id: record.id,
    occurredAt: record.occurredAt.toISOString(),
    action: record.action,
    actorUserId: record.actorUserId,
    targetUserId: record.targetUserId,
    requestId: record.requestId,
    metadata: parseAuditMetadata(record.metadata),
  };
}

export function toAuditRecordDtos(
  records: readonly StoredAuditRecord[],
): readonly AuthorizationAuditRecordDto[] {
  return records
    .map((record) => toAuditRecordDto(record))
    .filter((record): record is AuthorizationAuditRecordDto => record !== null);
}
