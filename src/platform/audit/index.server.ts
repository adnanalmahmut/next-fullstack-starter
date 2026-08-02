import "server-only";

/**
 * The controlled server-only entry point for the application audit platform.
 *
 * Everything outside this directory imports from here. The presentation
 * component is the one exception — it is a React component and is imported from
 * `./presentation` directly, the same way the other platform areas expose theirs.
 *
 * Importing this module opens no connection, reads no environment variable, and
 * has no side effect. There is no registry to populate: a catalog is a value a
 * composition root builds and passes in.
 *
 * ## What is deliberately not exported
 *
 * The repository. `insertAuditRecord` and `findAuditRecordPage` stay private, so
 * every write goes through one of the two writers and therefore through the
 * metadata policy, and every read goes through the reader and therefore through
 * the catalog. A repository handed out here would be a way to store an
 * unvalidated value and a way to read a record without re-checking it.
 *
 * Prisma types and delegates are absent for the same reason: the audit trail's
 * storage is an implementation detail of this directory.
 */

export {
  defineAuditAction,
  isValidAuditActionName,
  isValidAuditResourceType,
  MAX_AUDIT_ACTION_LENGTH,
  MAX_AUDIT_RESOURCE_TYPE_LENGTH,
  parseAuditMetadataForWrite,
  type AuditActionDefinition,
  type AuditActionDefinitionInput,
  type AuditActionRuntime,
} from "./audit-action";

export {
  auditActorSessionId,
  AUDIT_ACTOR_TYPE,
  AUDIT_ACTOR_TYPES,
  isAuditActor,
  MAX_AUDIT_ACTOR_ID_LENGTH,
  MAX_AUDIT_SESSION_ID_LENGTH,
  parseAuditActor,
  systemAuditActor,
  userAuditActor,
  type AuditActor,
  type AuditActorType,
} from "./audit-actor";

export {
  createAuditCatalog,
  EMPTY_AUDIT_CATALOG,
  type AuditCatalog,
} from "./audit-catalog";

export {
  decodeAuditCursor,
  encodeAuditCursor,
  MAX_AUDIT_CURSOR_LENGTH,
  type AuditCursor,
} from "./audit-cursor";

export {
  isAuditRequestId,
  isAuditResourceId,
  isCanonicalUuid,
  MAX_AUDIT_REQUEST_ID_LENGTH,
  MAX_AUDIT_RESOURCE_ID_LENGTH,
} from "./audit-identifier";

export {
  asAuditMetadata,
  AUDIT_METADATA_REJECTION,
  auditMetadataByteLength,
  checkAuditMetadata,
  FORBIDDEN_AUDIT_METADATA_KEYS,
  isAuditJsonValue,
  MAX_AUDIT_METADATA_BYTES,
  type AuditMetadata,
  type AuditMetadataRejection,
} from "./audit-metadata";

export {
  auditInputSchemas,
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  AUDIT_LIST_MIN_LIMIT,
  parseAuditListQuery,
  type AuditListQuery,
} from "./audit-query";

export {
  AUDIT_WRITE_REJECTION,
  prepareAuditRecordWrite,
  toAuditRecordDto,
  toAuditRecordDtos,
  type AuditRecordDto,
  type AuditRecordInput,
  type AuditRecordWrite,
  type AuditWriteRejection,
  type StoredAuditRecord,
} from "./audit-record";

export {
  AUDIT_RESULT,
  AUDIT_RESULTS,
  isAuditResult,
  type AuditResult,
} from "./audit-result";

export {
  AUDIT_LOG_FIELD_NAMES,
  toAuditLogFields,
  type AuditLogFields,
  type AuditLogInput,
} from "./audit-log-fields";

export {
  AUDIT_LOG_EVENT,
  AUDIT_LOG_EVENTS,
  type AuditLogEvent,
} from "./log-event";

export {
  appendAuditRecord,
  type AppendAuditRecordResult,
} from "./append-audit-record.server";

export { recordAuditPostCommit } from "./record-audit-post-commit.server";

export {
  listAuditRecords,
  type AuditRecordPage,
} from "./list-audit-records.server";
