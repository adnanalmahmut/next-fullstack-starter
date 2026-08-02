import "server-only";

import {
  type AuditActionDefinition,
  type AuditRecordInput,
  recordAuditPostCommit,
} from "@/platform/audit/index.server";
import type { StructuredLogger } from "@/platform/observability/create-logger.server";
import { logger } from "@/platform/observability/logger.server";

import { AUTHORIZATION_LOG_EVENT } from "../log-event";

/**
 * Records a completed identity change in the application audit trail.
 *
 * It is the post-commit writer, and that is forced rather than chosen. These
 * changes are performed by Better Auth: by the time the hook that calls this
 * runs, the provider has already committed, and there is no transaction of ours
 * left to join. The transactional writer is unusable here, and pretending
 * otherwise — opening a transaction after the fact and writing the record in it
 * — would look stronger while guaranteeing nothing.
 *
 * So the semantics from before the audit platform existed are preserved exactly:
 *
 * - a record is written only after the mutation succeeded;
 * - exactly one record per successful mutation;
 * - a refused mutation produces no record;
 * - a failed audit write never turns a completed change into a retryable
 *   failure.
 *
 * The success line stays here rather than moving into the platform. "An
 * administrative operation completed" is an authorization event with an
 * authorization audience; the platform's only event is the one for the write
 * that did not happen.
 */
export async function recordIdentityAudit<
  TMetadata extends object,
  TMetadataInput,
>(
  definition: AuditActionDefinition<TMetadata, TMetadataInput>,
  input: AuditRecordInput<TMetadataInput>,
  baseLogger: StructuredLogger = logger,
): Promise<boolean> {
  const written = await recordAuditPostCommit(definition, input, baseLogger);

  if (written) {
    baseLogger.info(
      {
        action: definition.name,
        actorUserId: input.actor.id,
        targetUserId: input.resourceId,
        requestId: input.requestId ?? null,
      },
      AUTHORIZATION_LOG_EVENT.ADMIN_OPERATION_COMPLETED,
    );
  }

  return written;
}
