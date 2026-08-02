import { APPLICATION_AUDIT_CATALOG } from "@/app/_composition/audit-catalog";
import {
  auditInputSchemas,
  listAuditRecords,
} from "@/platform/audit/index.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { AUTHORIZATION_MODE, defineRoute } from "@/platform/http/index.server";

/**
 * Lists the application audit trail, newest first.
 *
 * The path is unchanged, but what it reads is not: it is the generic trail now,
 * so a record written by any module appears here without this file being
 * touched. What it needs from the application is the catalog, which is the only
 * thing that can turn a stored action name back into a validated detail.
 *
 * Reading the trail needs its own capability, the page is bounded, and paging is
 * by cursor. There is no endpoint that updates, deletes, or exports a record,
 * because the platform has no such operation to expose.
 */
export const GET = defineRoute({
  name: "audit.record.list",
  input: { query: auditInputSchemas.listQuery },
  authorization: {
    mode: AUTHORIZATION_MODE.PERMISSION,
    permission: PERMISSION.AUDIT_RECORD_READ,
  },
  execute: ({ query }) => listAuditRecords(APPLICATION_AUDIT_CATALOG, query),
});
