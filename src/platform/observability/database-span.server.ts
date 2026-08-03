import "server-only";

import { ApplicationError } from "@/shared/errors/application-error";

import { SPAN_OUTCOME, withActiveSpan } from "./tracing.server";

/**
 * Spans for the database operations that are worth an operator's attention.
 *
 * ## Why this is a closed registry and not Prisma instrumentation
 *
 * `@prisma/instrumentation` would produce a span for every query automatically,
 * and it is deliberately not used. Two reasons, and the second is the one that
 * settles it:
 *
 * - A span per query is a span per `findUnique` in a loop. The volume is a cost
 *   nobody chose, and the signal is worse: fifty spans named `prisma:query` say
 *   less about a slow request than one span named `outbox.claim`.
 * - Automatic query spans carry the statement. `db.statement`, the table name, and
 *   the bind parameters are the point of that instrumentation, and they are exactly
 *   what must never leave this application: a parameter is a record id, an email
 *   address, or a token, and a statement is the schema.
 *
 * So the operations are named here, by hand, and the list is short on purpose. It
 * covers the *operational boundaries* — the places where a claim, a lease, a
 * receipt, or an append either works or does not — and nothing else. Adding an
 * entry is a reviewed change to this file rather than a decision made at a call
 * site, which is what keeps the span vocabulary as small as the questions an
 * operator actually asks.
 *
 * A span here carries the operation name, the outcome, and a stable error code
 * when there is one. It never carries SQL, a table name, a column, a bind value, a
 * row count of user records, a record id, a connection string, a host, or a schema.
 */
export const DATABASE_OPERATION = {
  /** One audit record appended, inside the caller's transaction. */
  AUDIT_APPEND: "audit.append",
  /** One bounded keyset page of the audit trail. */
  AUDIT_LIST: "audit.list",
  /** One outbox row written, inside the caller's transaction. */
  OUTBOX_WRITE: "outbox.write",
  /** The short claim transaction that leases a batch of due rows. */
  OUTBOX_CLAIM: "outbox.claim",
  /** The conditional update that records a successful publish. */
  OUTBOX_MARK_PUBLISHED: "outbox.mark_published",
  /** The conditional update that reschedules a failed publish. */
  OUTBOX_RESCHEDULE: "outbox.reschedule",
  /** The conditional update that moves a row to its dead letter. */
  OUTBOX_DEAD_LETTER: "outbox.dead_letter",
  /** The bounded aggregate behind the backlog gauges. */
  OUTBOX_BACKLOG: "outbox.backlog",
  /** The receipt-and-effect transaction that makes a job effect happen once. */
  JOB_EXECUTION_RECEIPT: "jobs.execution_receipt",
  /** The transaction that creates an upload intent and its pending object. */
  STORAGE_UPLOAD_INTENT_CREATE: "storage.upload_intent.create",
  /** The conditional update that takes or retakes a finalization lease. */
  STORAGE_FINALIZE_CLAIM: "storage.finalize.claim",
  /** The conditional update that promotes a verified object. */
  STORAGE_FINALIZE_COMMIT: "storage.finalize.commit",
  /** The conditional update that claims one expired intent for cleanup. */
  STORAGE_CLEANUP_CLAIM: "storage.cleanup.claim",
} as const;

export type DatabaseOperation =
  (typeof DATABASE_OPERATION)[keyof typeof DATABASE_OPERATION];

/** Every operation name, for the contract test that asserts the set is closed. */
export const DATABASE_OPERATIONS = Object.values(
  DATABASE_OPERATION,
) as readonly DatabaseOperation[];

const SPAN_NAME_PREFIX = "db.";

/** The attribute name, kept next to the registry so the catalog has one source. */
export const DATABASE_SPAN_ATTRIBUTE = {
  OPERATION_NAME: "db.operation.name",
} as const;

/**
 * Runs a database operation inside a span and returns exactly what it returns.
 *
 * The operation is a member of the registry above rather than a free string, so a
 * call site cannot name a span after a table, a query, or a record.
 *
 * A stable error code is attached only when the failure carries one. An unexpected
 * failure — a driver error, a constraint violation, a timeout — is recorded as
 * `failed` and nothing more: `INTERNAL_ERROR` would say no more than the outcome
 * already does, and anything richer would be the driver's message.
 */
export async function withDatabaseOperationSpan<T>(
  operation: DatabaseOperation,
  run: () => Promise<T>,
): Promise<T> {
  return withActiveSpan(
    `${SPAN_NAME_PREFIX}${operation}`,
    { [DATABASE_SPAN_ATTRIBUTE.OPERATION_NAME]: operation },
    async (span) => {
      try {
        const result = await run();

        span.setOutcome(SPAN_OUTCOME.SUCCEEDED);

        return result;
      } catch (error) {
        span.setOutcome(
          SPAN_OUTCOME.FAILED,
          error instanceof ApplicationError ? error.code : undefined,
        );

        throw error;
      }
    },
  );
}
