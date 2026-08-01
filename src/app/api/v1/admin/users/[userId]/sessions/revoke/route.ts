import { adminInputSchemas } from "@/platform/auth/authorization/admin-query";
import { revokeAdminUserSessions } from "@/platform/auth/authorization/admin-users.service.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { AUTHORIZATION_MODE, defineRoute } from "@/platform/http/index.server";

/**
 * Revokes every session of the target user.
 *
 * The subject is a user identifier taken from the path. A session token supplied
 * by a caller is never accepted, and revoking the acting administrator's own
 * sessions through this operation is refused by the resource policy.
 *
 * The operation produces no payload. It still answers `200` with `{"data":
 * null}`: the versioned API has one envelope, so a client never has to special
 * case an empty body.
 */
export const POST = defineRoute({
  name: "identity.admin.sessions.revoke",
  input: { params: adminInputSchemas.userParams },
  authorization: {
    mode: AUTHORIZATION_MODE.PERMISSION,
    permission: PERMISSION.IDENTITY_SESSION_REVOKE,
  },
  execute: async ({ params, actor }) => {
    await revokeAdminUserSessions({ actor }, params.userId);

    return null;
  },
});
