import { adminInputSchemas } from "@/platform/auth/authorization/admin-query";
import { setAdminUserRole } from "@/platform/auth/authorization/admin-users.service.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { AUTHORIZATION_MODE, defineRoute } from "@/platform/http/index.server";

/**
 * Replaces a user's role with a single approved role.
 *
 * The target comes from the path and the acting identity from the verified
 * session, so neither can be supplied in the body. Whether the change is allowed
 * for this record is a resource-policy decision applied inside the Better Auth
 * guard, which also records the audit entry.
 */
export const PATCH = defineRoute({
  name: "identity.admin.users.set-role",
  input: {
    params: adminInputSchemas.userParams,
    body: adminInputSchemas.setRoleBody,
  },
  authorization: {
    mode: AUTHORIZATION_MODE.PERMISSION,
    permission: PERMISSION.IDENTITY_USER_SET_ROLE,
  },
  execute: ({ params, body, actor }) =>
    setAdminUserRole({ actor }, params.userId, body.role),
});
