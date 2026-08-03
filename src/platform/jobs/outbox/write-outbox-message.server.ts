import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import {
  DATABASE_OPERATION,
  withDatabaseOperationSpan,
} from "@/platform/observability/database-span.server";
import { getRequestContext } from "@/platform/observability/request-context.server";
import {
  sanitizeTraceContext,
  type TraceContext,
} from "@/platform/observability/trace-context";
import { currentTraceContext } from "@/platform/observability/tracing.server";
import {
  DependencyUnavailableError,
  ValidationError,
} from "@/shared/errors/application-error";

import { isJobsEnabled } from "../config/jobs-config";
import type { JobDefinition } from "../definitions/define-job";
import {
  checkJobPayload,
  isValidJobIdentifier,
  PAYLOAD_REJECTION,
} from "../definitions/job-envelope";
import { JOB_LOG_LEVEL, logJobEvent } from "../observability/job-logger.server";
import { JOBS_LOG_EVENT } from "../observability/log-event";

/**
 * Recording the intent to run a job, inside the transaction that earns it.
 *
 * This is the only way work enters the queue, and the shape of the function is
 * the argument for it: it takes a transaction client, so there is no way to call
 * it *next to* a business change rather than *with* one. The row and the change
 * share a commit. If the transaction rolls back the row is gone; if it commits
 * the row survives a Redis outage, a worker crash, and a deployment, because it
 * is in PostgreSQL and nowhere else.
 *
 * What it deliberately does not do is contact Redis. Publishing is the
 * dispatcher's job, and it happens after the commit, in another process. An
 * `queue.add` here would be a network call inside a database transaction —
 * holding row locks open for the duration of someone else's outage — and it
 * would be able to succeed against a transaction that then rolls back, which is
 * precisely the failure the outbox pattern exists to remove.
 */
export type WriteOutboxMessageInput<
  TPayload,
  TPayloadInput = TPayload,
> = Readonly<{
  job: JobDefinition<TPayload, unknown, TPayloadInput>;
  /**
   * What the job's schema accepts, which is not always what it produces: a
   * schema with defaults is written so a caller does not have to spell them out.
   */
  payload: TPayloadInput;
  /**
   * Ties the work back to the request that caused it. Taken from the ambient
   * request context when the caller does not supply one.
   */
  correlationId?: string;
  causationId?: string;
  /** Taken from the active span when the caller does not supply one. */
  traceContext?: TraceContext;
  /** The earliest the message may be published. Defaults to immediately. */
  availableAt?: Date;
}>;

export type OutboxWriteResult = Readonly<{ outboxId: string }>;

/**
 * Refuses the Prisma singleton at runtime, not only in the type.
 *
 * `Prisma.TransactionClient` is a structural type, so a `PrismaClient` satisfies
 * enough of it to be passed by a caller who is in a hurry — and it would work,
 * silently, right up until a rollback failed to remove the row.
 *
 * Connection management is what separates the two. The singleton owns the pool
 * and exposes `$connect` and `$disconnect`; an interactive transaction client is
 * a handle on one connection that is already open and exposes neither. (It does
 * still expose `$transaction`, so that is not the discriminator it looks like.)
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
      "writeOutboxMessage requires an interactive transaction client, not the Prisma singleton.",
    );
  }
}

function resolveCorrelationId(supplied: string | undefined): string {
  if (supplied !== undefined) {
    if (!isValidJobIdentifier(supplied)) {
      throw new ValidationError(
        "The correlation identifier is not acceptable.",
      );
    }

    return supplied;
  }

  const ambient = getRequestContext()?.requestId;

  return ambient !== undefined && isValidJobIdentifier(ambient)
    ? ambient
    : randomUUID();
}

export async function writeOutboxMessage<TPayload, TPayloadInput = TPayload>(
  tx: Prisma.TransactionClient,
  input: WriteOutboxMessageInput<TPayload, TPayloadInput>,
): Promise<OutboxWriteResult> {
  // Enabled, but not connected: the flag says whether this application records
  // background work at all, and answering that question needs no Redis address.
  if (!isJobsEnabled()) {
    throw new DependencyUnavailableError("Background jobs are not enabled.");
  }

  assertTransactionClient(tx);

  const { job } = input;
  const rejection = checkJobPayload(input.payload);

  if (rejection === PAYLOAD_REJECTION.NOT_JSON) {
    throw new ValidationError("The job payload must be JSON serializable.");
  }

  if (rejection === PAYLOAD_REJECTION.TOO_LARGE) {
    throw new ValidationError("The job payload exceeds the transport limit.");
  }

  const parsed = job.payloadSchema.safeParse(input.payload);

  if (!parsed.success) {
    throw new ValidationError("The job payload does not match its schema.");
  }

  // Re-measured after parsing: a schema with defaults produces a larger value
  // than the one that was handed in, and it is the produced value that travels.
  if (checkJobPayload(parsed.data) !== null) {
    throw new ValidationError("The job payload exceeds the transport limit.");
  }

  if (
    input.causationId !== undefined &&
    !isValidJobIdentifier(input.causationId)
  ) {
    throw new ValidationError("The causation identifier is not acceptable.");
  }

  const correlationId = resolveCorrelationId(input.correlationId);
  const trace =
    sanitizeTraceContext(input.traceContext) ?? currentTraceContext();

  // Generated here rather than by the database, so the caller holds the
  // identifier the moment the write is issued and can carry it into its own
  // response, its own log line, and the causation chain of a follow-up message.
  const outboxId = randomUUID();

  // The insert is the operational boundary worth a span: it is the moment the
  // intent to run a job becomes durable, inside the caller's transaction. The span
  // carries the operation name and the outcome and nothing about the row — no job
  // name, no payload, no identifier.
  await withDatabaseOperationSpan(DATABASE_OPERATION.OUTBOX_WRITE, async () => {
    await tx.outboxMessage.create({
      data: {
        id: outboxId,
        jobName: job.name,
        jobVersion: job.version,
        payload: parsed.data as Prisma.InputJsonValue,
        correlationId,
        ...(input.causationId === undefined
          ? {}
          : { causationId: input.causationId }),
        ...(trace?.traceparent === undefined
          ? {}
          : { traceparent: trace.traceparent }),
        ...(trace?.tracestate === undefined
          ? {}
          : { tracestate: trace.tracestate }),
        ...(input.availableAt === undefined
          ? {}
          : { availableAt: input.availableAt }),
      },
      select: { id: true },
    });
  });

  // Emitted inside the caller's transaction, which is why it is `debug` and why
  // it says "written" rather than "committed": a rollback leaves this line with
  // no row behind it. The row, not the line, is the record.
  logJobEvent(JOB_LOG_LEVEL.DEBUG, JOBS_LOG_EVENT.OUTBOX_WRITTEN, {
    jobName: job.name,
    jobVersion: job.version,
    outboxId,
    correlationId,
    ...(input.causationId === undefined
      ? {}
      : { causationId: input.causationId }),
  });

  return { outboxId };
}
