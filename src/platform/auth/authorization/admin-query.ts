import * as z from "zod";

import { ValidationError } from "@/shared/errors/application-error";

/**
 * Input schemas for the administration reads.
 *
 * Every list is bounded, every sort field comes from an allowlist, and the only
 * searchable field is fixed. A caller can never name a column, an operator, or an
 * unbounded page size.
 */
export const ADMIN_USERS_SORT_FIELDS = ["createdAt", "email", "name"] as const;

export const ADMIN_USERS_MAX_LIMIT = 50;
export const ADMIN_USERS_DEFAULT_LIMIT = 20;
export const ADMIN_USERS_MAX_OFFSET = 10_000;

export const ADMIN_AUDIT_MAX_LIMIT = 50;
export const ADMIN_AUDIT_DEFAULT_LIMIT = 20;

/** The single field a search term is matched against. */
export const ADMIN_USERS_SEARCH_FIELD = "email" as const;

const adminUsersQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ADMIN_USERS_MAX_LIMIT)
      .default(ADMIN_USERS_DEFAULT_LIMIT),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(ADMIN_USERS_MAX_OFFSET)
      .default(0),
    sortBy: z.enum(ADMIN_USERS_SORT_FIELDS).default("createdAt"),
    sortDirection: z.enum(["asc", "desc"]).default("desc"),
    search: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export type AdminUsersQuery = z.output<typeof adminUsersQuerySchema>;

const adminAuditQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ADMIN_AUDIT_MAX_LIMIT)
      .default(ADMIN_AUDIT_DEFAULT_LIMIT),
  })
  .strict();

export type AdminAuditQuery = z.output<typeof adminAuditQuerySchema>;

const userIdSchema = z.string().trim().min(1).max(255);

/**
 * The target identifier, taken from the request path and never from a body.
 *
 * A route declares this as its `params` schema, so the identifier is validated by
 * the same boundary that validates everything else and the handler never reads a
 * raw path segment.
 */
const adminUserParamsSchema = z
  .object({
    userId: userIdSchema,
  })
  .strict();

export type AdminUserParams = z.output<typeof adminUserParamsSchema>;

/**
 * The requested role in a role-change body.
 *
 * The value stays a plain string here on purpose: whether it is an approved role
 * is a policy decision, not an input-shape decision, so the policy owns it and
 * answers with the status a caller should see.
 */
const setRoleBodySchema = z
  .object({
    role: z.string(),
  })
  .strict();

export type SetRoleBody = z.output<typeof setRoleBodySchema>;

/**
 * The schemas the Route Handler factory validates each part of a request with.
 *
 * They are exported as schemas rather than as parse functions because the factory
 * owns parsing: a route declares what a part must look like and never calls a
 * parser itself.
 */
export const adminInputSchemas = {
  usersQuery: adminUsersQuerySchema,
  auditQuery: adminAuditQuerySchema,
  userParams: adminUserParamsSchema,
  setRoleBody: setRoleBodySchema,
} as const;

function parse<TOutput>(schema: z.ZodType<TOutput>, value: unknown): TOutput {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new ValidationError("The request input is not acceptable.");
  }

  return result.data;
}

/**
 * The defaulted query a Server Component renders its first page with.
 *
 * A page has no search parameters to validate; it needs the same bounds the API
 * applies, resolved from the same schema.
 */
export function parseAdminUsersQuery(value: unknown): AdminUsersQuery {
  return parse(adminUsersQuerySchema, value);
}

export function parseAdminAuditQuery(value: unknown): AdminAuditQuery {
  return parse(adminAuditQuerySchema, value);
}
