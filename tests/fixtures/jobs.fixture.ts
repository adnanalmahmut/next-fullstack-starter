import { randomUUID } from "node:crypto";

import { database } from "@/platform/database/index.server";
import {
  closeJobQueue,
  resetJobsConfiguration,
} from "@/platform/jobs/index.server";
import { requireJobQueue } from "@/platform/jobs/queue/job-queue.server";

/**
 * Test-side helpers for the background-jobs suite.
 *
 * Two rules shape everything here. Cleanup is *targeted*: a run removes the rows
 * it created and obliterates the queue it created, and never anything wider —
 * `FLUSHDB`, `FLUSHALL`, and `KEYS` would erase another run sharing the server,
 * and a contract test refuses all three anywhere in the repository. And waiting
 * is *bounded*: every wait has a deadline and a small interval, so a broken
 * assumption fails in a second rather than hanging until the runner gives up.
 */
export type JobQueue = Awaited<ReturnType<typeof requireJobQueue>>;

/**
 * Puts the process into an enabled, addressed, uniquely scoped jobs
 * configuration.
 *
 * The run identifier comes from `JOBS_TEST_RUN_ID` when the runner supplies one
 * — CI does — and is generated otherwise, so two runs against one Redis can
 * never consume each other's jobs.
 */
export function configureJobsForTest(
  overrides: Record<string, string> = {},
): string {
  const runId = process.env.JOBS_TEST_RUN_ID ?? `local-${randomUUID()}`;

  process.env.JOBS_ENABLED = "true";
  process.env.JOBS_TEST_RUN_ID = runId;
  process.env.JOBS_REDIS_URL ??= "redis://127.0.0.1:6379";

  for (const [name, value] of Object.entries(overrides)) {
    process.env[name] = value;
  }

  resetJobsConfiguration();

  return runId;
}

/**
 * Removes everything one file created.
 *
 * `obliterate` is scoped to this run's queue prefix, so it cannot reach another
 * run's keys; the outbox rows are matched on the correlation identifier the file
 * tagged them with.
 */
export async function cleanupJobsRun(correlationId: string): Promise<void> {
  try {
    const queue = await requireJobQueue();

    await queue.obliterate({ force: true });
  } catch {
    // A file that never reached Redis has nothing to obliterate.
  }

  await closeJobQueue();
  await database.outboxMessage.deleteMany({ where: { correlationId } });
}

export const DEFAULT_DEADLINE_MS = 4_000;
const POLL_INTERVAL_MS = 25;

/**
 * Waits for a condition, with a deadline.
 *
 * A fixed `sleep` is the usual alternative and it is worse in both directions:
 * too short and the suite is flaky, too long and every run pays for the slowest
 * machine that ever ran it.
 */
export async function waitFor<T>(
  what: string,
  read: () => Promise<T | null | undefined | false>,
  deadlineMs = DEFAULT_DEADLINE_MS,
): Promise<T> {
  const until = Date.now() + deadlineMs;

  for (;;) {
    const value = await read();

    if (value !== null && value !== undefined && value !== false) {
      return value;
    }

    if (Date.now() >= until) {
      throw new Error(`Timed out waiting for ${what}.`);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** The current state of one outbox row, or `null`. */
export async function readOutboxRow(id: string) {
  return database.outboxMessage.findUnique({ where: { id } });
}
