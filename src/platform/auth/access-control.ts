import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  userAc,
} from "better-auth/plugins/admin/access";

/**
 * Access control for the Better Auth Admin plugin.
 *
 * The statements are the plugin's own user and session capabilities. No business
 * resource is invented here: feature permissions such as catalog or order
 * actions belong to the module that owns them, in the pull request that
 * introduces it.
 */
export const accessControl = createAccessControl(defaultStatements);

export const USER_ROLE = "user";
export const ADMIN_ROLE = "admin";

/**
 * `user` intentionally holds no administrative capability, and `admin` keeps
 * only what the plugin already defines. Impersonating other administrators is
 * not granted.
 */
export const authorizationRoles = {
  [USER_ROLE]: userAc,
  [ADMIN_ROLE]: adminAc,
};

export const DEFAULT_ROLE = USER_ROLE;
export const ADMIN_ROLES = [ADMIN_ROLE];
