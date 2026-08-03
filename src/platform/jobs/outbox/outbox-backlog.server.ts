import "server-only";

import { database } from "@/platform/database/index.server";
import {
  DATABASE_OPERATION,
  withDatabaseOperationSpan,
} from "@/platform/observability/database-span.server";
import {
  registerOutboxBacklogObserver,
  type MetricObserverRegistration,
  type OutboxBacklogSnapshot,
} from "@/platform/observability/metrics.server";

import { isJobsEnabled } from "../config/jobs-config";

/**
 * The outbox backlog, as four numbers.
 *
 * A backlog is the one thing about background work that no application code
 * knows: it is a property of the table at a moment in time, so it has to be asked
 * of PostgreSQL when a metric is collected rather than counted as events happen.
 * That is what makes it an observable gauge.
 *
 * Three constraints shape this file, and each one is a decision rather than an
 * implementation detail:
 *
 * - **Worker only.** The dispatcher runs in the worker, and so does this. A web
 *   instance must never poll the outbox on a timer: it would put a periodic query
 *   behind every request-serving process, multiply it by the instance count, and
 *   make a backlog reading depend on how many web instances happen to be running.
 * - **PostgreSQL is the source.** Redis is not consulted, and no queue connection
 *   is opened. The outbox is a table; its depth is a question for the table.
 * - **The query is bounded.** Counting an unbounded table on every collection
 *   cycle would make the metric more expensive than the work it measures, so the
 *   aggregate runs over a bounded sample of rows that are actually interesting —
 *   unpublished or dead-lettered — and published history is never scanned.
 *
 * The backlog is deliberately **not** a readiness condition. A deep backlog means
 * the worker has work to do, not that the deployment is unhealthy, and a probe that
 * failed on it would take instances out of service exactly when they were needed.
 */

/**
 * The ceiling on rows the aggregate inspects.
 *
 * A sample rather than a total, and it is honest about it: past this depth the
 * exact number has stopped being the useful signal — "more than ten thousand
 * pending" and "eleven thousand pending" call for the same action.
 */
export const MAX_OUTBOX_BACKLOG_SAMPLE = 10_000;

type BacklogRow = Readonly<{
  pending: bigint;
  due: bigint;
  leased: bigint;
  deadLettered: bigint;
}>;

function toCount(value: bigint | number): number {
  // PostgreSQL `count(*)` is `bigint`, which Prisma hands back as a `BigInt`. The
  // sample ceiling keeps it far inside the safe integer range.
  return typeof value === "bigint" ? Number(value) : value;
}

/**
 * Reads the four counts in one bounded statement.
 *
 * `FILTER` rather than four queries: one pass over the sample, one round trip, one
 * consistent moment. `now()` is evaluated by the database so the four numbers agree
 * with each other rather than with four different clock readings.
 */
export async function readOutboxBacklog(): Promise<OutboxBacklogSnapshot> {
  const rows = await withDatabaseOperationSpan(
    DATABASE_OPERATION.OUTBOX_BACKLOG,
    () =>
      database.$queryRaw<BacklogRow[]>`
        SELECT
          count(*) FILTER (
            WHERE b."publishedAt" IS NULL AND b."deadLetteredAt" IS NULL
          ) AS "pending",
          count(*) FILTER (
            WHERE b."publishedAt" IS NULL
              AND b."deadLetteredAt" IS NULL
              AND b."availableAt" <= now()
              AND (b."lockedUntil" IS NULL OR b."lockedUntil" <= now())
          ) AS "due",
          count(*) FILTER (
            WHERE b."publishedAt" IS NULL
              AND b."deadLetteredAt" IS NULL
              AND b."lockedUntil" > now()
          ) AS "leased",
          count(*) FILTER (WHERE b."deadLetteredAt" IS NOT NULL) AS "deadLettered"
        FROM (
          SELECT m."publishedAt",
                 m."deadLetteredAt",
                 m."availableAt",
                 m."lockedUntil"
            FROM "outbox_message" AS m
           WHERE m."publishedAt" IS NULL OR m."deadLetteredAt" IS NOT NULL
           LIMIT ${MAX_OUTBOX_BACKLOG_SAMPLE}
        ) AS b
      `,
  );

  const row = rows[0];

  if (!row) {
    return { pending: 0, due: 0, leased: 0, deadLettered: 0 };
  }

  return {
    pending: toCount(row.pending),
    due: toCount(row.due),
    leased: toCount(row.leased),
    deadLettered: toCount(row.deadLettered),
  };
}

/**
 * Arms the backlog gauges, when background jobs are on.
 *
 * When jobs are disabled nothing is registered and no callback exists, so a
 * deployment that never enabled the outbox never queries it. The returned
 * registration is cancelled during shutdown, which is what stops a collection
 * cycle from starting against a database connection that is about to close.
 */
export function startOutboxBacklogMetrics(): MetricObserverRegistration {
  if (!isJobsEnabled()) {
    return { unregister: () => undefined };
  }

  return registerOutboxBacklogObserver(readOutboxBacklog);
}
