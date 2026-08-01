/**
 * Stable log event names for background jobs.
 *
 * They are language-neutral identifiers, not user-facing text, and they are the
 * only vocabulary an operator has to learn to follow a piece of work from the
 * transaction that recorded it to the attempt that finished it.
 *
 * The level is chosen by what an operator would do about the line. A queued or
 * claimed message is `debug`; a retry is `info`, because it is expected and
 * bounded; a failure that will be retried is `warn`; a dead-letter is `error`,
 * because it is the one state that will not resolve itself.
 */
export const JOBS_LOG_EVENT = {
  JOB_QUEUED: "job.queued",
  JOB_STARTED: "job.started",
  JOB_SUCCEEDED: "job.succeeded",
  JOB_FAILED: "job.failed",
  JOB_RETRYING: "job.retrying",
  JOB_TIMED_OUT: "job.timed_out",
  JOB_DEAD_LETTERED: "job.dead_lettered",
  JOB_STALLED: "job.stalled",

  OUTBOX_WRITTEN: "outbox.written",
  OUTBOX_CLAIMED: "outbox.claimed",
  OUTBOX_PUBLISHED: "outbox.published",
  OUTBOX_PUBLISH_FAILED: "outbox.publish_failed",
  OUTBOX_DEAD_LETTERED: "outbox.dead_lettered",

  /**
   * A connection-level failure, reported by role rather than by a field.
   *
   * The two roles fail for different reasons and are fixed in different ways: a
   * producer that cannot reach Redis leaves outbox rows pending, while a worker
   * that cannot reach Redis stops consuming. Naming them separately keeps that
   * distinction in the event rather than pushing it into the field allowlist.
   */
  QUEUE_PRODUCER_CONNECTION_FAILED: "queue.producer.connection_failed",
  QUEUE_WORKER_CONNECTION_FAILED: "queue.worker.connection_failed",

  WORKER_STARTED: "worker.started",
  WORKER_READY: "worker.ready",
  WORKER_STOPPING: "worker.stopping",
  WORKER_STOPPED: "worker.stopped",
} as const;

export type JobsLogEvent = (typeof JOBS_LOG_EVENT)[keyof typeof JOBS_LOG_EVENT];

export const JOBS_LOG_EVENTS: readonly JobsLogEvent[] =
  Object.values(JOBS_LOG_EVENT);
