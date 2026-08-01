import "server-only";

import { database } from "@/platform/database/index.server";

import { ADMIN_ROLE } from "./role";

/**
 * Bounded, read-only queries over the identity tables.
 *
 * Better Auth owns every write to `user` and `session`; nothing here modifies a
 * row. These two reads exist because the resource policies need facts Better
 * Auth does not expose as a single call: the target's current role, and whether
 * another administrator would remain after a demotion.
 */
export type IdentityUserRole = Readonly<{
  id: string;
  role: string | null;
}>;

export async function findUserRoleById(
  userId: string,
): Promise<IdentityUserRole | null> {
  return database.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });
}

/**
 * Counts the users other than `excludedUserId` that hold the admin role.
 *
 * The role column holds a single role for every user this application creates,
 * and Better Auth represents multiple roles as a comma separated list. The four
 * comparisons match the admin role as a whole list entry, so a longer name that
 * merely contains it is not counted.
 *
 * The users table is small and the query has no supporting index; adding one
 * would mean changing a Better Auth owned model, which this change avoids.
 */
export async function countOtherAdmins(
  excludedUserId: string,
): Promise<number> {
  return database.user.count({
    where: {
      id: { not: excludedUserId },
      OR: [
        { role: ADMIN_ROLE },
        { role: { startsWith: `${ADMIN_ROLE},` } },
        { role: { endsWith: `,${ADMIN_ROLE}` } },
        { role: { contains: `,${ADMIN_ROLE},` } },
      ],
    },
  });
}
