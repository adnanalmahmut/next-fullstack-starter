import "server-only";

import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

import {
  getJobsConfiguration,
  getJobsRedisConfiguration,
  isJobQueueConfigured,
} from "../config/jobs-config";
import type { JobBackoff } from "../definitions/define-job";

import {
  closeJobsConnection,
  createProducerConnection,
} from "./connection.server";

/**
 * The one queue, and the one place a `Queue` is constructed.
 *
 * There is a single queue on purpose. Several queues buy priority isolation and
 * cost a worker per queue, a dispatcher decision per message, and a second place
 * for a job to be lost; a starter that shipped four of them would be shipping a
 * topology nobody has measured. One queue, many job names, and a concurrency
 * setting is the shape that stays correct while a project is small — and the
 * dispatcher is the only publisher, so splitting it later is a change in one
 * file.
 *
 * These functions are deliberately **not** re-exported from
 * `@/platform/jobs/index.server`. Business code enqueues work by writing an
 * outbox row inside its transaction; if it could reach `queue.add` it would
 * eventually call it next to a transaction rather than inside one, and that is
 * exactly the bug the outbox exists to prevent. A contract test holds the line.
 */
export const JOBS_QUEUE_NAME = "jobs";

/**
 * How long a finished job stays inspectable.
 *
 * Completed jobs are kept far longer than the outbox lease and the dispatcher's
 * recovery window, and that retention is load-bearing rather than a nicety: the
 * dispatcher republishes with the outbox row's identifier as the BullMQ job id,
 * so a job record that still exists is what stops a crash between `queue.add`
 * and the `publishedAt` update from running the work twice. Remove completed
 * jobs aggressively and that protection disappears.
 *
 * Failed jobs are kept longer still, and are never removed on failure: the
 * failed set *is* the operational dead-letter store, and a queue that deletes
 * its failures has nowhere to look after an incident.
 */
export const COMPLETED_JOB_RETENTION = {
  age: 24 * 60 * 60,
  count: 5_000,
} as const;

export const FAILED_JOB_RETENTION = {
  age: 14 * 24 * 60 * 60,
  count: 20_000,
} as const;

type JobQueueState = {
  queue?: Queue;
  connection?: Redis;
};

/**
 * Held on `globalThis` for the same reason the Prisma client is: a development
 * reload re-evaluates the module, and a second `Queue` would mean a second
 * connection per reload.
 */
const globalForJobQueue = globalThis as typeof globalThis & {
  jobQueueState?: JobQueueState;
};

function state(): JobQueueState {
  globalForJobQueue.jobQueueState ??= {};

  return globalForJobQueue.jobQueueState;
}

/**
 * The job options a message is published with, derived from its definition.
 *
 * Nothing here is chosen at the call site: the retry budget, the backoff, and
 * the retention are properties of the job, declared once in `defineJob`.
 */
export function jobOptionsFor(
  jobId: string,
  attempts: number,
  backoff: JobBackoff,
): JobsOptions {
  return {
    jobId,
    attempts,
    backoff: { type: backoff.type, delay: backoff.delayMs },
    removeOnComplete: { ...COMPLETED_JOB_RETENTION },
    removeOnFail: { ...FAILED_JOB_RETENTION },
  };
}

/**
 * The queue, or `null` when jobs are switched off.
 *
 * `null` means "not configured", and nothing else. An enabled queue whose Redis
 * cannot be reached rejects on use instead, because answering `null` there would
 * let the dispatcher treat an outage as a deliberate absence and quietly stop
 * publishing.
 */
export async function getJobQueue(): Promise<Queue | null> {
  if (!isJobQueueConfigured()) {
    return null;
  }

  return requireJobQueue();
}

export async function requireJobQueue(): Promise<Queue> {
  const current = state();

  if (current.queue) {
    return current.queue;
  }

  const { url, queuePrefix } = getJobsRedisConfiguration();
  const connection = createProducerConnection(url);

  current.connection = connection;
  current.queue = new Queue(JOBS_QUEUE_NAME, {
    connection,
    prefix: queuePrefix,
  });

  return current.queue;
}

/**
 * Closes the queue and the connection it owns, and forgets both.
 *
 * The connection is created here, so it is closed here: BullMQ does not close a
 * connection it was handed. No signal handler is registered — a platform module
 * that installed one would be deciding the shutdown behaviour of every process
 * that imports it.
 */
export async function closeJobQueue(): Promise<void> {
  const current = state();
  const { queue, connection } = current;

  current.queue = undefined;
  current.connection = undefined;

  if (queue) {
    try {
      await queue.close();
    } catch {
      // A queue that will not close cleanly must not stop a shutdown; the
      // connection below is torn down either way.
    }
  }

  if (connection) {
    await closeJobsConnection(connection);
  }
}

/** The queue prefix in force, for diagnostics. Never opens a connection. */
export function jobQueuePrefix(): string {
  return getJobsConfiguration().queuePrefix;
}
