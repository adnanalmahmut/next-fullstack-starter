import "server-only";

import { database } from "@/platform/database/index.server";
import type { Prisma } from "@/generated/prisma/client";
import {
  DATABASE_OPERATION,
  withDatabaseOperationSpan,
} from "@/platform/observability/database-span.server";

/**
 * A database effect that happens once, however many times the job is delivered.
 *
 * Delivery is at-least-once. That is a property of every queue, this one
 * included, and no amount of care in the dispatcher changes it: a worker can
 * finish the work and die before acknowledging it, and the message comes back.
 * The only place that can be made exactly-once is the database, and only by
 * writing the proof in the *same* transaction as the effect.
 *
 * That is what this does:
 *
 * 1. open one transaction;
 * 2. try to insert the receipt, ignoring a duplicate;
 * 3. if the insert changed nothing, the work is already done — return, having
 *    done nothing;
 * 4. otherwise run the effect against the same transaction;
 * 5. commit both together, or roll back both together.
 *
 * The insert comes first, and it uses `createMany({ skipDuplicates: true })`
 * rather than a `findUnique` followed by a `create`. A check-then-write has a
 * window between the two in which a second worker can pass the same check; the
 * unique index closes it. `skipDuplicates` rather than a caught constraint
 * violation because in PostgreSQL a failed statement aborts the surrounding
 * transaction — catching the error would leave the transaction unusable and the
 * effect unrunnable.
 *
 * What this does **not** give you: an HTTP call to a payment provider or an
 * email API is not covered. The receipt says the database effect happened, not
 * that a third party saw exactly one request. External work needs the provider's
 * own idempotency key, and where a provider has none — most SMS and some mail
 * APIs — a duplicate is possible and must be acceptable. Keep a handler small
 * and atomic; a handler that charges a card, writes a row, and sends a receipt
 * has three different delivery guarantees in one function.
 */
export type DatabaseJobExecution<TResult> = Readonly<{
  executionKey: string;
  jobName: string;
  jobVersion: number;
  execute: (tx: Prisma.TransactionClient) => Promise<TResult>;
}>;

export type DatabaseJobOutcome<TResult> =
  Readonly<{ executed: true; result: TResult }> | Readonly<{ executed: false }>;

export async function runDatabaseJobOnce<TResult>(
  execution: DatabaseJobExecution<TResult>,
): Promise<DatabaseJobOutcome<TResult>> {
  const { executionKey, jobName, jobVersion, execute } = execution;

  if (typeof executionKey !== "string" || executionKey.length === 0) {
    throw new Error("A job execution requires an execution key.");
  }

  // The span covers the receipt *and* the effect, because they are one
  // transaction and one operational fact: either both happened or neither did.
  // It carries the operation name and the outcome — never the execution key,
  // which is derived from the payload's idempotency key.
  return withDatabaseOperationSpan(
    DATABASE_OPERATION.JOB_EXECUTION_RECEIPT,
    () =>
      database.$transaction(
        async (tx): Promise<DatabaseJobOutcome<TResult>> => {
          const claimed = await tx.jobExecutionReceipt.createMany({
            data: [{ executionKey, jobName, jobVersion }],
            skipDuplicates: true,
          });

          if (claimed.count === 0) {
            return { executed: false };
          }

          const result = await execute(tx);

          return { executed: true, result };
        },
      ),
  );
}
