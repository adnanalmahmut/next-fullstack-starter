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

const setRoleBodySchema = z
  .object({
    role: z.string(),
  })
  .strict();

export type SetRoleBody = z.output<typeof setRoleBodySchema>;

function parse<TOutput>(schema: z.ZodType<TOutput>, value: unknown): TOutput {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new ValidationError("The request input is not acceptable.");
  }

  return result.data;
}

export function parseAdminUsersQuery(value: unknown): AdminUsersQuery {
  return parse(adminUsersQuerySchema, value);
}

export function parseAdminAuditQuery(value: unknown): AdminAuditQuery {
  return parse(adminAuditQuerySchema, value);
}

/** Validates a target identifier taken from the request path, never from a body. */
export function parseTargetUserId(value: unknown): string {
  return parse(userIdSchema, value);
}

/**
 * Reads the requested role from a request body.
 *
 * The value stays a plain string here on purpose: whether it is an approved role
 * is a policy decision, not an input-shape decision, so the policy owns it and
 * answers with the status a caller should see.
 */
export function parseSetRoleBody(value: unknown): SetRoleBody {
  return parse(setRoleBodySchema, value);
}

/** Turns URL search parameters into a plain object for validation. */
export function toQueryRecord(
  searchParams: URLSearchParams,
): Record<string, string> {
  return Object.fromEntries(searchParams);
}
