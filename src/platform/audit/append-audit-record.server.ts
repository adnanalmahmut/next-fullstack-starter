import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { ValidationError } from "@/shared/errors/application-error";

import type { AuditActionDefinition } from "./audit-action";
import { type AuditRecordInput, prepareAuditRecordWrite } from "./audit-record";
import { insertAuditRecord } from "./audit-repository.server";

/**
 * Recording a change inside the transaction that made it.
 *
 * The signature is the argument. It takes a transaction client, so there is no
 * way to call it *next to* a change rather than *with* one: the row and the
 * change share a commit. If the transaction rolls back the record is gone, and
 * if it commits the record is there — a change that happened without a record,
 * or a record of a change that did not happen, are both unreachable states
 * rather than states that are merely unlikely.
 *
 * That is the strongest guarantee this platform offers, and it is the one to
 * reach for whenever the change is a database write the application controls.
 *
 * ## What it does not do
 *
 * It contacts nothing. No Redis, no queue, no outbox row, no network call of any
 * kind — every one of those would be an unbounded wait inside a transaction that
 * is holding row locks, and one of them could succeed against a transaction that
 * then rolls back.
 *
 * It also does not catch database failures. That is not an omission: a failure
 * here *must* propagate, because the whole point is that the audit record and
 * the change succeed or fail together. Swallowing it would leave the change
 * committed and unrecorded, which is exactly the outcome the transactional
 * writer exists to prevent.
 *
 * A caller whose change is not a database write — a provider call, an external
 * mutation — cannot use this, and should use `recordAuditPostCommit`, which is
 * honest about the weaker guarantee.
 */
export type AppendAuditRecordResult = Readonly<{ id: string }>;

/**
 * Refuses the Prisma singleton at runtime, not only in the type.
 *
 * `Prisma.TransactionClient` is a structural type, so a `PrismaClient` satisfies
 * enough of it to be passed by a caller in a hurry — and it would work,
 * silently, right up until a rollback failed to remove the record.
 *
 * Connection management is what separates the two. The singleton owns the pool
 * and exposes `$connect` and `$disconnect`; an interactive transaction client is
 * a handle on one already-open connection and exposes neither. It does still
 * expose `$transaction`, so that is not the discriminator it looks like.
 */
function assertTransactionClient(tx: Prisma.TransactionClient): void {
  const candidate = tx as {
    $connect?: unknown;
    $disconnect?: unknown;
  };

  if (
    typeof candidate.$connect === "function" ||
    typeof candidate.$disconnect === "function"
  ) {
    throw new Error(
      "appendAuditRecord requires an interactive transaction client, not the Prisma singleton.",
    );
  }
}

export async function appendAuditRecord<
  TMetadata extends object,
  TMetadataInput,
>(
  tx: Prisma.TransactionClient,
  definition: AuditActionDefinition<TMetadata, TMetadataInput>,
  input: AuditRecordInput<TMetadataInput>,
): Promise<AppendAuditRecordResult> {
  assertTransactionClient(tx);

  const prepared = prepareAuditRecordWrite(definition, input);

  if (!prepared.ok) {
    // A `ValidationError` rather than a bare `Error`: it is a refusal a caller
    // could in principle have avoided, and the transaction it aborts is the
    // caller's own. The reason is a stable code and names nothing from the
    // input, so it is safe wherever the failure is eventually reported.
    throw new ValidationError(
      `The audit record was refused: ${prepared.reason}.`,
    );
  }

  return { id: await insertAuditRecord(tx, prepared.write) };
}
