import { adminInputSchemas } from "@/platform/auth/authorization/admin-query";
import { listAdminUsers } from "@/platform/auth/authorization/admin-users.service.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { AUTHORIZATION_MODE, defineRoute } from "@/platform/http/index.server";

/**
 * Lists users for the administration area.
 *
 * The adapter declares and delegates. Reading the session, requiring the
 * capability, validating the query, normalizing an error, and writing the
 * envelope all belong to the factory; the list itself belongs to the service.
 */
export const GET = defineRoute({
  name: "identity.admin.users.list",
  input: { query: adminInputSchemas.usersQuery },
  authorization: {
    mode: AUTHORIZATION_MODE.PERMISSION,
    permission: PERMISSION.IDENTITY_USER_LIST,
  },
  execute: ({ query, actor }) => listAdminUsers({ actor }, query),
});
