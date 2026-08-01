import * as z from "zod";

import { InternalError } from "@/shared/errors/application-error";

import { normalizeRoles } from "./role";

/**
 * The allowlisted view of a user for the administration area and API.
 *
 * Everything Better Auth knows about a user that a reader does not need is left
 * out: no credential or account data, no session token, no IP address, no user
 * agent, and no ban metadata. Adding a field here is a deliberate contract
 * change.
 */
export type AdminUserDto = Readonly<{
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  roles: readonly string[];
  createdAt: string;
}>;

export type AdminUserListPage = Readonly<{
  users: readonly AdminUserDto[];
  total: number;
  limit: number;
  offset: number;
}>;

/**
 * The provider payload is validated before it is mapped.
 *
 * Better Auth is a dependency, not a trusted internal caller: a payload that no
 * longer matches this shape is a failure rather than something to pass through.
 */
const providerUserSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  role: z.unknown().optional(),
  createdAt: z.coerce.date(),
});

export function toAdminUserDto(value: unknown): AdminUserDto {
  const result = providerUserSchema.safeParse(value);

  if (!result.success) {
    throw new InternalError(
      "The authentication provider returned an unexpected user shape.",
    );
  }

  return {
    id: result.data.id,
    name: result.data.name,
    email: result.data.email,
    emailVerified: result.data.emailVerified,
    roles: normalizeRoles(result.data.role),
    createdAt: result.data.createdAt.toISOString(),
  };
}

export function toAdminUserDtos(
  values: readonly unknown[],
): readonly AdminUserDto[] {
  return values.map((value) => toAdminUserDto(value));
}
