import { adminInputSchemas } from "@/platform/auth/authorization/admin-query";
import { getAdminUser } from "@/platform/auth/authorization/admin-users.service.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { AUTHORIZATION_MODE, defineRoute } from "@/platform/http/index.server";

/**
 * Reads one user.
 *
 * The factory requires the capability before the target identifier is validated
 * or loaded, so a caller without it cannot learn whether an identifier exists. An
 * authorized caller receives a genuine `404` for a missing user.
 */
export const GET = defineRoute({
  name: "identity.admin.users.read",
  input: { params: adminInputSchemas.userParams },
  authorization: {
    mode: AUTHORIZATION_MODE.PERMISSION,
    permission: PERMISSION.IDENTITY_USER_READ,
  },
  execute: ({ params, actor }) => getAdminUser({ actor }, params.userId),
});
