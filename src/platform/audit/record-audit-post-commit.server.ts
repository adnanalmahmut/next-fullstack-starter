import "server-only";

import { database } from "@/platform/database/index.server";
import type { StructuredLogger } from "@/platform/observability/create-logger.server";
import { logger } from "@/platform/observability/logger.server";
import { toSafeLogError } from "@/platform/observability/safe-error";

import type { AuditActionDefinition } from "./audit-action";
import { toAuditLogFields } from "./audit-log-fields";
import { type AuditRecordInput, prepareAuditRecordWrite } from "./audit-record";
import { insertAuditRecord } from "./audit-repository.server";
import { AUDIT_LOG_EVENT } from "./log-event";

/**
 * Recording a change that has already happened.
 *
 * The weaker of the two writers, and it exists because some changes are not
 * database writes this application controls. A Better Auth mutation is the
 * standing example: by the time the application knows it succeeded, the provider
 * has already committed it, and there is no transaction left to join.
 *
 * So the guarantee is different, and stating it plainly matters more than
 * dressing it up: **the change can succeed and the record can be lost**. There
 * is a window, it is small, and there is no reconciliation process that would
 * close it. What there is, is a log line — which is why that line is the one
 * thing this function is careful about.
 *
 * ## Why it returns `false` instead of throwing
 *
 * The change is done. Turning a storage failure into an exception would push it
 * up to a caller who can only do one of two wrong things: report a completed
 * change as failed, or retry it and apply it twice. Neither is better than a
 * missing audit record, and the second is considerably worse. So the failure is
 * recorded where an operator will see it, the answer is `false`, and the
 * caller's success stands.
 *
 * A caller that treats `false` as fatal has misunderstood the contract; a caller
 * that ignores it entirely has not, because the log line is the record of the
 * failure.
 */
export async function recordAuditPostCommit<
  TMetadata extends object,
  TMetadataInput,
>(
  definition: AuditActionDefinition<TMetadata, TMetadataInput>,
  input: AuditRecordInput<TMetadataInput>,
  baseLogger: StructuredLogger = logger,
): Promise<boolean> {
  const prepared = prepareAuditRecordWrite(definition, input);

  if (!prepared.ok) {
    baseLogger.error(
      toAuditLogFields({
        action: definition.name,
        actorType: input.actor?.type,
        actorId: input.actor?.id,
        resourceType: definition.resourceType,
        resourceId: input.resourceId,
        result: input.result,
        requestId: input.requestId,
        errorCode: prepared.reason,
      }),
      AUDIT_LOG_EVENT.RECORD_WRITE_FAILED,
    );

    return false;
  }

  try {
    await insertAuditRecord(database, prepared.write);

    return true;
  } catch (error) {
    // `toSafeLogError` reduces the throw to a classification. The raw error
    // never reaches the line: a driver exception carries the statement, its
    // parameters, and sometimes the connection string, and this line is durable.
    baseLogger.error(
      toAuditLogFields({
        action: prepared.write.action,
        actorType: prepared.write.actor.type,
        actorId: prepared.write.actor.id,
        resourceType: prepared.write.resourceType,
        resourceId: prepared.write.resourceId,
        result: prepared.write.result,
        requestId: prepared.write.requestId,
        errorCode: toSafeLogError(error).errorCode,
      }),
      AUDIT_LOG_EVENT.RECORD_WRITE_FAILED,
    );

    return false;
  }
}
