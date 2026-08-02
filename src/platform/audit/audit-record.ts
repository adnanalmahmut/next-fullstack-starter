import {
  type AuditActionDefinition,
  parseAuditMetadataForWrite,
} from "./audit-action";
import {
  type AuditActor,
  type AuditActorType,
  isAuditActor,
} from "./audit-actor";
import type { AuditCatalog } from "./audit-catalog";
import { isAuditRequestId, isAuditResourceId } from "./audit-identifier";
import type { AuditMetadata } from "./audit-metadata";
import { isAuditResult, type AuditResult } from "./audit-result";

/**
 * What the platform writes, and what a reader receives.
 *
 * The two are separate types because they are not the same set of fields, and
 * the difference is the point: `actorSessionId` is written and is never read
 * back. There is no code path that selects it into a DTO, so there is no code
 * path that can render it, log it, or return it from an endpoint.
 */
export type AuditRecordWrite = Readonly<{
  actor: AuditActor;
  action: string;
  resourceType: string;
  resourceId: string;
  result: AuditResult;
  requestId: string | null;
  metadata: AuditMetadata | null;
  occurredAt?: Date;
}>;

/**
 * The row shape the repository selects.
 *
 * It is declared here rather than imported from Prisma so the mapping below can
 * be unit tested without a database, and so a change to the generated client
 * cannot silently widen what a reader sees.
 */
export type StoredAuditRecord = Readonly<{
  id: string;
  occurredAt: Date;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result: AuditResult;
  requestId: string | null;
  metadata: unknown;
}>;

/**
 * What an API response and a rendered page are built from.
 *
 * Everything is already a transport value: the timestamp is an ISO string, the
 * enums are their stable string forms, and `metadata` is either an object that
 * has been re-validated against its action's schema or `null`. Nothing here is a
 * Prisma value, a `Date`, or an unvalidated blob.
 */
export type AuditRecordDto = Readonly<{
  id: string;
  occurredAt: string;
  actor: Readonly<{
    type: AuditActorType;
    id: string;
  }>;
  action: string;
  resource: Readonly<{
    type: string;
    id: string;
  }>;
  result: AuditResult;
  requestId: string | null;
  metadata: AuditMetadata | null;
}>;

/**
 * Maps one stored row for a reader.
 *
 * A row is never dropped. Not when its action is unknown to the catalog, not
 * when its stored metadata no longer parses, not when the definition that wrote
 * it has been deleted from the codebase. A record that disappears from an audit
 * trail because of a refactor is worse than a record with a missing detail
 * column, and an attacker who could make a record unreadable could make it
 * invisible.
 *
 * What is withheld in those cases is the metadata alone, replaced by `null`.
 * The raw value is never passed through: it was written under a contract that no
 * longer holds, and the reader has no way to know what is in it.
 */
export function toAuditRecordDto(
  record: StoredAuditRecord,
  catalog: AuditCatalog,
): AuditRecordDto {
  const definition = catalog.find(record.action);

  return {
    id: record.id,
    occurredAt: record.occurredAt.toISOString(),
    actor: {
      type: record.actorType,
      id: record.actorId,
    },
    action: record.action,
    resource: {
      type: record.resourceType,
      id: record.resourceId,
    },
    result: record.result,
    requestId: record.requestId,
    metadata: definition?.readStoredMetadata(record.metadata) ?? null,
  };
}

export function toAuditRecordDtos(
  records: readonly StoredAuditRecord[],
  catalog: AuditCatalog,
): readonly AuditRecordDto[] {
  return records.map((record) => toAuditRecordDto(record, catalog));
}

/**
 * What a call site supplies.
 *
 * `action` and `resourceType` are conspicuously absent: they come from the
 * definition, so a caller cannot record one action under another's name, and
 * cannot claim a resource type the action never declared.
 */
export type AuditRecordInput<TMetadataInput> = Readonly<{
  actor: AuditActor;
  resourceId: string;
  result: AuditResult;
  /** Absent or `null` when there was no request behind the change. */
  requestId?: string | null;
  metadata: TMetadataInput;
  /** Defaults to the moment the row is written. */
  occurredAt?: Date;
}>;

/**
 * Why a candidate write was refused.
 *
 * A closed set of stable codes rather than a message, because both writers turn
 * this into something durable — an exception a transaction fails on, or a log
 * line with an allowlisted `errorCode` — and neither may carry a value from the
 * input it rejected.
 */
export const AUDIT_WRITE_REJECTION = {
  ACTOR: "invalid-actor",
  RESOURCE_ID: "invalid-resource-id",
  RESULT: "invalid-result",
  REQUEST_ID: "invalid-request-id",
  METADATA: "invalid-metadata",
} as const;

export type AuditWriteRejection =
  (typeof AUDIT_WRITE_REJECTION)[keyof typeof AUDIT_WRITE_REJECTION];

export type PreparedAuditWrite =
  | Readonly<{ ok: true; write: AuditRecordWrite }>
  | Readonly<{ ok: false; reason: AuditWriteRejection }>;

/**
 * Turns a definition and an input into the row that would be written.
 *
 * Pure, and shared by both writers, so the transactional path and the
 * post-commit path cannot drift into validating different things. They differ in
 * what they do with a refusal, never in what counts as one.
 */
export function prepareAuditRecordWrite<
  TMetadata extends object,
  TMetadataInput,
>(
  definition: AuditActionDefinition<TMetadata, TMetadataInput>,
  input: AuditRecordInput<TMetadataInput>,
): PreparedAuditWrite {
  if (!isAuditActor(input.actor)) {
    return { ok: false, reason: AUDIT_WRITE_REJECTION.ACTOR };
  }

  if (!isAuditResourceId(input.resourceId)) {
    return { ok: false, reason: AUDIT_WRITE_REJECTION.RESOURCE_ID };
  }

  if (!isAuditResult(input.result)) {
    return { ok: false, reason: AUDIT_WRITE_REJECTION.RESULT };
  }

  const requestId = input.requestId ?? null;

  if (requestId !== null && !isAuditRequestId(requestId)) {
    return { ok: false, reason: AUDIT_WRITE_REJECTION.REQUEST_ID };
  }

  const metadata = parseAuditMetadataForWrite(definition, input.metadata);

  if (!metadata.ok) {
    return { ok: false, reason: AUDIT_WRITE_REJECTION.METADATA };
  }

  return {
    ok: true,
    write: {
      actor: input.actor,
      action: definition.name,
      resourceType: definition.resourceType,
      resourceId: input.resourceId,
      result: input.result,
      requestId,
      metadata: metadata.metadata,
      ...(input.occurredAt === undefined
        ? {}
        : { occurredAt: input.occurredAt }),
    },
  };
}
