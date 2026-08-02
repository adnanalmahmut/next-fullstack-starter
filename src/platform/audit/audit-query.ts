import * as z from "zod";

import { ValidationError } from "@/shared/errors/application-error";

import { MAX_AUDIT_CURSOR_LENGTH } from "./audit-cursor";

/**
 * What a caller may ask a reader for.
 *
 * A page size with a floor and a ceiling, and an opaque cursor. That is the
 * whole surface. There is no offset, no total count, no sort field, no filter
 * expression, and no "all" — an audit table only grows, so anything unbounded
 * here would be a query that gets slower every day and eventually times out on
 * the page an incident is being investigated from.
 *
 * The total count is missing on purpose rather than by omission. `count(*)` on
 * an append-only table is a sequential scan, it is wrong by the time it is
 * rendered, and no reader of an audit trail needs it: they need the most recent
 * records and a way to keep going.
 */
export const AUDIT_LIST_MIN_LIMIT = 1;
export const AUDIT_LIST_MAX_LIMIT = 50;
export const AUDIT_LIST_DEFAULT_LIMIT = 20;

const auditListQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(AUDIT_LIST_MIN_LIMIT)
      .max(AUDIT_LIST_MAX_LIMIT)
      .default(AUDIT_LIST_DEFAULT_LIMIT),
    /**
     * Bounded before it is decoded.
     *
     * The decoder validates the contents; this bounds the work the decoder is
     * asked to do in the first place.
     */
    cursor: z.string().min(1).max(MAX_AUDIT_CURSOR_LENGTH).optional(),
  })
  .strict();

export type AuditListQuery = z.output<typeof auditListQuerySchema>;

/**
 * The schemas an entry point declares.
 *
 * Exported as schemas rather than as parse functions because the Route Handler
 * factory owns parsing: a route declares what a part must look like and never
 * calls a parser itself.
 */
export const auditInputSchemas = {
  listQuery: auditListQuerySchema,
} as const;

/**
 * The defaulted query a Server Component renders its first page with, and the
 * one it renders a subsequent page with.
 *
 * A page has no factory to validate its search parameters, so it parses them
 * through the same schema the API uses. A refusal is a `ValidationError`, which
 * is the same answer the API gives for the same input.
 */
export function parseAuditListQuery(value: unknown): AuditListQuery {
  const result = auditListQuerySchema.safeParse(value);

  if (!result.success) {
    throw new ValidationError("The audit query is not acceptable.");
  }

  return result.data;
}
