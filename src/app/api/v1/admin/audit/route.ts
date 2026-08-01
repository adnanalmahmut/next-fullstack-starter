import { listAuthorizationAudit } from "@/platform/auth/authorization/admin-audit.service.server";
import { adminInputSchemas } from "@/platform/auth/authorization/admin-query";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { AUTHORIZATION_MODE, defineRoute } from "@/platform/http/index.server";

/**
 * Lists the most recent authorization audit records.
 *
 * Reading the audit trail needs its own capability, and the page is bounded.
 * There is no endpoint that updates, deletes, or exports a record.
 */
export const GET = defineRoute({
  name: "identity.admin.audit.list",
  input: { query: adminInputSchemas.auditQuery },
  authorization: {
    mode: AUTHORIZATION_MODE.PERMISSION,
    permission: PERMISSION.IDENTITY_AUDIT_READ,
  },
  execute: ({ query, actor }) => listAuthorizationAudit({ actor }, query),
});
