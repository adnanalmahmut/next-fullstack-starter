import "server-only";

import { randomUUID } from "node:crypto";

import { database } from "@/platform/database/index.server";
import {
  DATABASE_OPERATION,
  withDatabaseOperationSpan,
} from "@/platform/observability/database-span.server";
import { ERROR_BOUNDARY } from "@/platform/observability/error-monitoring/error-monitor";
import { captureUnexpectedError } from "@/platform/observability/error-monitoring/error-monitor.server";
import {
  recordOutboxDeadLettered,
  recordOutboxPublish,
  recordOutboxPublishRetry,
} from "@/platform/observability/metrics.server";
import { sanitizeTraceContext } from "@/platform/observability/trace-context";
import {
  currentTraceContext,
  runWithRemoteTraceContext,
} from "@/platform/observability/tracing.server";

import {
  getJobsConfiguration,
  isJobQueueConfigured,
} from "../config/jobs-config";
import type { JobEnvelope } from "../definitions/job-envelope";
import {
  checkJobPayload,
  PAYLOAD_REJECTION,
} from "../definitions/job-envelope";
import type { JobRegistry } from "../definitions/job-registry";
import { JOB_OUTCOME, type JobOutcome } from "../observability/job-log-fields";
import { JOB_LOG_LEVEL, logJobEvent } from "../observability/job-logger.server";
import { JOBS_LOG_EVENT } from "../observability/log-event";
import { JOB_SPAN, withJobSpan } from "../observability/tracing";
import { jobOptionsFor, requireJobQueue } from "../queue/job-queue.server";

import {
  OUTBOX_DEAD_LETTER_CODE,
  OUTBOX_ERROR_CODE,
  outboxBackoffDelayMs,
  type OutboxDeadLetterReason,
  type OutboxErrorCode,
} from "./outbox-message";

/**
 * The half of the outbox pattern that talks to Redis.
 *
 * It runs inside the worker process, never inside Next.js, and it is the only
 * publisher: a message reaches the queue because a committed row said so, not
 * because a request handler asked for it.
 *
 * The two phases are kept strictly apart, and that separation is the point:
 *
 * - **Claim** is a short PostgreSQL transaction. It selects due rows with
 *   `FOR UPDATE SKIP LOCKED`, stamps a lease, bumps the attempt counter, and
 *   commits. `SKIP LOCKED` is what lets two dispatchers run at once without
 *   coordinating: each simply walks past the rows the other is holding.
 * - **Publish** happens after that commit. No Redis call is ever made with a
 *   transaction open — a network call inside a transaction holds row locks for
 *   the duration of somebody else's outage.
 *
 * ## The crash window
 *
 * There is a gap between `queue.add` succeeding and `publishedAt` being written.
 * A process that dies inside it leaves a row that looks unpublished and a job
 * that exists. The next dispatcher republishes with the *same* `jobId` — the
 * outbox row's id — and BullMQ refuses to create a second job while a job with
 * that id is still retained, which is why completed jobs are kept far longer
 * than the lease.
 *
 * That narrows the window; it does not close it. Once the retained job is
 * evicted, a republish creates a genuinely new job. **Delivery is at-least-once
 * and this project does not claim otherwise.** Handlers must be idempotent; the
 * database side of that is `runDatabaseJobOnce`.
 */
export type OutboxDispatchSummary = Readonly<{
  claimed: number;
  published: number;
  failed: number;
  deadLettered: number;
}>;

export type OutboxDispatcher = Readonly<{
  id: string;
  runOnce: () => Promise<OutboxDispatchSummary>;
  start: () => void;
  stop: () => Promise<void>;
  isRunning: () => boolean;
}>;

type ClaimedRow = {
  id: string;
  jobName: string;
  jobVersion: number;
  payload: unknown;
  correlationId: string;
  causationId: string | null;
  traceparent: string | null;
  tracestate: string | null;
  occurredAt: Date;
  publishAttempts: number;
};

const EMPTY_SUMMARY: OutboxDispatchSummary = {
  claimed: 0,
  published: 0,
  failed: 0,
  deadLettered: 0,
};

/** The safe identity of a failure: a class name, never a message or an address. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "UnknownError";
}

/**
 * The job identity a row contributes to a metric, or a placeholder.
 *
 * `job.name` and `job.version` are acceptable metric dimensions because the job
 * registry is closed and small — the number of time series is a property of the
 * code. A row written by a newer release, or by one whose definition has since
 * been removed, carries a name that is *not* in that registry, and using it would
 * let the dimension grow without bound. So an unresolvable row is counted under one
 * shared identity, which is also the only honest label for it.
 */
const UNRESOLVED_JOB_NAME = "unresolved";
const UNRESOLVED_JOB_VERSION = 0;

function metricIdentity(
  row: ClaimedRow,
  registry: JobRegistry,
): Readonly<{ jobName: string; jobVersion: number }> {
  return registry.resolve(row.jobName, row.jobVersion)
    ? { jobName: row.jobName, jobVersion: row.jobVersion }
    : { jobName: UNRESOLVED_JOB_NAME, jobVersion: UNRESOLVED_JOB_VERSION };
}

const PUBLISH_METRIC_OUTCOME = {
  published: JOB_OUTCOME.SUCCEEDED,
  failed: JOB_OUTCOME.RETRYING,
  "dead-lettered": JOB_OUTCOME.DEAD_LETTERED,
} as const satisfies Readonly<Record<PublishOutcome, JobOutcome>>;

type PublishOutcome = "published" | "failed" | "dead-lettered";

export type OutboxDispatcherOptions = Readonly<{
  registry: JobRegistry;
  /** Overridden only by tests that need two dispatchers with stable identities. */
  dispatcherId?: string;
}>;

export function createOutboxDispatcher(
  options: OutboxDispatcherOptions,
): OutboxDispatcher {
  const { registry } = options;
  const dispatcherId = options.dispatcherId ?? randomUUID();

  let running = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  /**
   * An interruptible wait.
   *
   * A plain `setTimeout` would make a shutdown take up to one poll interval and
   * would keep the event loop alive while it did.
   */
  function idle(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, ms);

      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });
  }

  async function claim(now: Date, batchSize: number, leaseMs: number) {
    const lockedUntil = new Date(now.getTime() + leaseMs);

    // One statement, one short transaction. The sub-select decides which rows
    // are due and skips the ones another dispatcher is holding; the outer
    // update stamps the lease and increments the attempt counter so a row that
    // keeps failing eventually reaches its dead-letter rather than looping.
    return withDatabaseOperationSpan(DATABASE_OPERATION.OUTBOX_CLAIM, () =>
      database.$transaction(
        async (tx) =>
          tx.$queryRaw<ClaimedRow[]>`
          UPDATE "outbox_message" AS m
             SET "lockedBy" = ${dispatcherId},
                 "lockedUntil" = ${lockedUntil},
                 "publishAttempts" = m."publishAttempts" + 1,
                 "updatedAt" = ${now}
           WHERE m."id" IN (
             SELECT c."id"
               FROM "outbox_message" AS c
              WHERE c."publishedAt" IS NULL
                AND c."deadLetteredAt" IS NULL
                AND c."availableAt" <= ${now}
                AND (c."lockedUntil" IS NULL OR c."lockedUntil" <= ${now})
              ORDER BY c."availableAt", c."createdAt", c."id"
              LIMIT ${batchSize}
              FOR UPDATE SKIP LOCKED
           )
       RETURNING m."id",
                 m."jobName",
                 m."jobVersion",
                 m."payload",
                 m."correlationId",
                 m."causationId",
                 m."traceparent",
                 m."tracestate",
                 m."occurredAt",
                 m."publishAttempts"
        `,
      ),
    );
  }

  async function deadLetter(
    row: ClaimedRow,
    reason: OutboxDeadLetterReason,
    errorCode?: OutboxErrorCode,
  ): Promise<void> {
    await withDatabaseOperationSpan(DATABASE_OPERATION.OUTBOX_DEAD_LETTER, () =>
      database.outboxMessage.updateMany({
        where: { id: row.id, deadLetteredAt: null },
        data: {
          deadLetteredAt: new Date(),
          deadLetterCode: reason,
          lockedBy: null,
          lockedUntil: null,
          ...(errorCode === undefined ? {} : { lastErrorCode: errorCode }),
        },
      }),
    );

    logJobEvent(JOB_LOG_LEVEL.ERROR, JOBS_LOG_EVENT.OUTBOX_DEAD_LETTERED, {
      jobName: row.jobName,
      jobVersion: row.jobVersion,
      outboxId: row.id,
      correlationId: row.correlationId,
      attempt: row.publishAttempts,
      outcome: JOB_OUTCOME.DEAD_LETTERED,
      errorCode: reason,
    });
  }

  async function reschedule(
    row: ClaimedRow,
    errorCode: OutboxErrorCode,
    maxPublishAttempts: number,
    backoffBaseMs: number,
  ): Promise<boolean> {
    if (row.publishAttempts >= maxPublishAttempts) {
      await deadLetter(
        row,
        OUTBOX_DEAD_LETTER_CODE.PUBLISH_ATTEMPTS_EXHAUSTED,
        errorCode,
      );

      return true;
    }

    const delayMs = outboxBackoffDelayMs(
      row.publishAttempts,
      backoffBaseMs,
      row.id,
    );

    await withDatabaseOperationSpan(DATABASE_OPERATION.OUTBOX_RESCHEDULE, () =>
      database.outboxMessage.updateMany({
        where: { id: row.id, publishedAt: null, deadLetteredAt: null },
        data: {
          lockedBy: null,
          lockedUntil: null,
          availableAt: new Date(Date.now() + delayMs),
          lastErrorCode: errorCode,
        },
      }),
    );

    logJobEvent(JOB_LOG_LEVEL.WARN, JOBS_LOG_EVENT.OUTBOX_PUBLISH_FAILED, {
      jobName: row.jobName,
      jobVersion: row.jobVersion,
      outboxId: row.id,
      correlationId: row.correlationId,
      attempt: row.publishAttempts,
      maxAttempts: maxPublishAttempts,
      delayMs,
      outcome: JOB_OUTCOME.RETRYING,
      errorCode,
    });

    return false;
  }

  async function publish(
    row: ClaimedRow,
    maxPublishAttempts: number,
    backoffBaseMs: number,
  ): Promise<PublishOutcome> {
    const runtime = registry.resolve(row.jobName, row.jobVersion);

    if (!runtime) {
      await deadLetter(
        row,
        registry.hasName(row.jobName)
          ? OUTBOX_DEAD_LETTER_CODE.UNSUPPORTED_VERSION
          : OUTBOX_DEAD_LETTER_CODE.UNKNOWN_JOB,
      );

      return "dead-lettered";
    }

    // Size is checked before shape so an oversized payload is reported as
    // oversized rather than as a schema mismatch; they are fixed differently.
    const rejection = checkJobPayload(row.payload);

    if (rejection !== null) {
      await deadLetter(
        row,
        rejection === PAYLOAD_REJECTION.TOO_LARGE
          ? OUTBOX_DEAD_LETTER_CODE.PAYLOAD_TOO_LARGE
          : OUTBOX_DEAD_LETTER_CODE.INVALID_PAYLOAD,
      );

      return "dead-lettered";
    }

    const parsed = runtime.parsePayload(row.payload);

    if (!parsed.ok) {
      await deadLetter(row, OUTBOX_DEAD_LETTER_CODE.INVALID_PAYLOAD);

      return "dead-lettered";
    }

    // The context the *request* recorded, read back from the row. It is the
    // parent of everything below, which is what makes a request and the job it
    // caused one trace rather than two.
    const storedTraceContext = sanitizeTraceContext({
      traceparent: row.traceparent ?? undefined,
      tracestate: row.tracestate ?? undefined,
    });

    // Building the queue and using it fail for different reasons and are
    // recorded as different codes: the first is a misconfiguration an operator
    // fixes, the second is usually Redis being down and will clear on its own.
    let queue;

    try {
      queue = await requireJobQueue();
    } catch {
      const exhausted = await reschedule(
        row,
        OUTBOX_ERROR_CODE.QUEUE_UNAVAILABLE,
        maxPublishAttempts,
        backoffBaseMs,
      );

      return exhausted ? "dead-lettered" : "failed";
    }

    try {
      // The stored context is restored first, so the publish span is a child of
      // the request that wrote the row — minutes or hours earlier, in another
      // process. Malformed context is dropped and the publish span becomes a
      // root: a mangled header must never stop a message being published.
      await runWithRemoteTraceContext(storedTraceContext, () =>
        withJobSpan(
          JOB_SPAN.OUTBOX_PUBLISH,
          {
            jobName: row.jobName,
            jobVersion: row.jobVersion,
            outboxId: row.id,
            attempt: row.publishAttempts,
          },
          // The BullMQ job id *is* the outbox row id. That is what makes a
          // republish after a crash idempotent for as long as the completed job
          // is retained.
          async () => {
            // Built inside the span, and this is the whole reason the envelope is
            // not assembled earlier: the context injected here is the *publish
            // span's*, so the worker's execute span becomes its child rather than
            // a second child of the original request. The chain is therefore
            // request → publish → execute, in one trace, with real parentage at
            // each hop.
            const publishTraceContext = currentTraceContext();

            const envelope: JobEnvelope<unknown> = {
              jobName: row.jobName,
              version: row.jobVersion,
              payload: parsed.payload,
              outboxId: row.id,
              correlationId: row.correlationId,
              ...(row.causationId === null
                ? {}
                : { causationId: row.causationId }),
              occurredAt: row.occurredAt.toISOString(),
              // Absent with no SDK registered, which is a correct envelope and
              // not a degraded one.
              ...(publishTraceContext === undefined
                ? {}
                : { traceContext: publishTraceContext }),
            };

            await queue.add(
              runtime.identity,
              envelope,
              jobOptionsFor(row.id, runtime.attempts, runtime.backoff),
            );
          },
        ),
      );
    } catch {
      const exhausted = await reschedule(
        row,
        OUTBOX_ERROR_CODE.PUBLISH_FAILED,
        maxPublishAttempts,
        backoffBaseMs,
      );

      return exhausted ? "dead-lettered" : "failed";
    }

    const marked = await withDatabaseOperationSpan(
      DATABASE_OPERATION.OUTBOX_MARK_PUBLISHED,
      () =>
        database.outboxMessage.updateMany({
          where: { id: row.id, publishedAt: null },
          data: {
            publishedAt: new Date(),
            lockedBy: null,
            lockedUntil: null,
            lastErrorCode: null,
          },
        }),
    );

    if (marked.count === 0) {
      // Another dispatcher published this row while this one held a stale
      // lease. BullMQ deduplicated the second `add` by job id, so nothing was
      // queued twice; there is simply nothing left to record.
      logJobEvent(JOB_LOG_LEVEL.DEBUG, JOBS_LOG_EVENT.OUTBOX_PUBLISHED, {
        jobName: row.jobName,
        jobVersion: row.jobVersion,
        outboxId: row.id,
        correlationId: row.correlationId,
        outcome: JOB_OUTCOME.SKIPPED,
        errorCode: OUTBOX_ERROR_CODE.LEASE_LOST,
      });

      return "published";
    }

    logJobEvent(JOB_LOG_LEVEL.DEBUG, JOBS_LOG_EVENT.OUTBOX_PUBLISHED, {
      jobName: row.jobName,
      jobVersion: row.jobVersion,
      outboxId: row.id,
      correlationId: row.correlationId,
      attempt: row.publishAttempts,
      outcome: JOB_OUTCOME.SUCCEEDED,
    });

    logJobEvent(JOB_LOG_LEVEL.DEBUG, JOBS_LOG_EVENT.JOB_QUEUED, {
      jobName: row.jobName,
      jobVersion: row.jobVersion,
      jobId: row.id,
      outboxId: row.id,
      correlationId: row.correlationId,
    });

    return "published";
  }

  async function runOnce(): Promise<OutboxDispatchSummary> {
    if (!isJobQueueConfigured()) {
      return EMPTY_SUMMARY;
    }

    const { outbox } = getJobsConfiguration();
    const rows = await claim(new Date(), outbox.batchSize, outbox.leaseMs);

    if (rows.length === 0) {
      return EMPTY_SUMMARY;
    }

    logJobEvent(JOB_LOG_LEVEL.DEBUG, JOBS_LOG_EVENT.OUTBOX_CLAIMED, {
      batchSize: rows.length,
    });

    let published = 0;
    let failed = 0;
    let deadLettered = 0;

    // Sequential on purpose. A batch is small, the work is a single Redis
    // round trip each, and publishing in order keeps a queue's arrival order
    // close to the order the transactions committed in.
    for (const row of rows) {
      const outcome = await publish(
        row,
        outbox.maxPublishAttempts,
        outbox.backoffBaseMs,
      );

      // Recorded here and nowhere else. `publish` has four early returns and two
      // failure paths, and counting inside it would mean six call sites and an
      // eventual double count; one place per row is one place per attempt by
      // construction.
      const identity = metricIdentity(row, registry);

      recordOutboxPublish({
        ...identity,
        outcome: PUBLISH_METRIC_OUTCOME[outcome],
      });

      if (outcome === "published") {
        published += 1;
      } else if (outcome === "dead-lettered") {
        deadLettered += 1;
        recordOutboxDeadLettered(identity);
      } else {
        failed += 1;
        recordOutboxPublishRetry(identity);
      }
    }

    return { claimed: rows.length, published, failed, deadLettered };
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;

    loop = (async () => {
      const { outbox } = getJobsConfiguration();

      while (running) {
        let claimed = 0;

        try {
          claimed = (await runOnce()).claimed;
        } catch (error) {
          // A dispatcher that dies on a transient database error stops
          // publishing for everyone. It waits and tries again instead.
          logJobEvent(
            JOB_LOG_LEVEL.ERROR,
            JOBS_LOG_EVENT.OUTBOX_PUBLISH_FAILED,
            { outcome: JOB_OUTCOME.FAILED, errorCode: errorName(error) },
          );

          // The one failure this boundary owns: something that threatens the
          // dispatcher loop itself rather than one message. A per-row publish
          // failure is *not* reported here — it is expected traffic during a Redis
          // blip, it is already rescheduled with backoff, and reporting it would
          // send one event per retry per row.
          captureUnexpectedError(error, { boundary: ERROR_BOUNDARY.OUTBOX });
        }

        if (!running) {
          break;
        }

        // A full-ish batch means there is probably more waiting, so the next
        // pass starts immediately; an empty one means the backlog is drained
        // and the interval is the right amount of patience.
        if (claimed === 0) {
          await idle(outbox.pollIntervalMs);
        }
      }
    })();
  }

  async function stop(): Promise<void> {
    running = false;
    wake?.();

    const pending = loop;

    loop = undefined;

    if (pending) {
      await pending;
    }
  }

  return {
    id: dispatcherId,
    runOnce,
    start,
    stop,
    isRunning: () => running,
  };
}
