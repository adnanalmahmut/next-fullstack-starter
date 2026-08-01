import "server-only";

import type { StructuredLogger } from "@/platform/observability/create-logger.server";
import { logger } from "@/platform/observability/logger.server";
import { toSafeLogError } from "@/platform/observability/safe-error";

import { AUTHORIZATION_LOG_EVENT } from "../log-event";

import { appendAuthorizationAuditRecord } from "./audit-repository.server";
import type { AuthorizationAuditWrite } from "./audit-record";

/**
 * Appends an audit record for a mutation that already succeeded.
 *
 * A completed administrative change must not be reported back as a retryable
 * failure, because retrying would apply it twice. So a storage failure here is
 * recorded as a high-severity structured error and the caller continues.
 *
 * The log line carries only identifiers, the action, the request id, and a safe
 * error classification. The raw error, the request, and the metadata are never
 * logged.
 *
 * The known limitation is documented in
 * `docs/architecture/authorization-admin-access-control.md`: a lost record leaves
 * no application-level reconciliation path yet.
 */
export async function recordAuthorizationAudit(
  record: AuthorizationAuditWrite,
  baseLogger: StructuredLogger = logger,
): Promise<boolean> {
  try {
    await appendAuthorizationAuditRecord(record);

    baseLogger.info(
      {
        action: record.action,
        actorUserId: record.actorUserId,
        targetUserId: record.targetUserId,
        requestId: record.requestId,
      },
      AUTHORIZATION_LOG_EVENT.ADMIN_OPERATION_COMPLETED,
    );

    return true;
  } catch (error) {
    baseLogger.error(
      {
        ...toSafeLogError(error),
        action: record.action,
        actorUserId: record.actorUserId,
        targetUserId: record.targetUserId,
        requestId: record.requestId,
      },
      AUTHORIZATION_LOG_EVENT.AUDIT_WRITE_FAILED,
    );

    return false;
  }
}
