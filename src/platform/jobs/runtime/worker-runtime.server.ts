import "server-only";

import { Worker } from "bullmq";

import {
  getJobsConfiguration,
  getJobsRedisConfiguration,
} from "../config/jobs-config";
import type { JobRegistry } from "../definitions/job-registry";
import { createJobProcessor } from "../execution/job-processor.server";
import { JOB_OUTCOME } from "../observability/job-log-fields";
import { JOB_LOG_LEVEL, logJobEvent } from "../observability/job-logger.server";
import { JOBS_LOG_EVENT } from "../observability/log-event";
import {
  createOutboxDispatcher,
  type OutboxDispatcher,
} from "../outbox/outbox-dispatcher.server";
import {
  closeJobsConnection,
  createWorkerConnection,
} from "../queue/connection.server";
import { closeJobQueue, JOBS_QUEUE_NAME } from "../queue/job-queue.server";

/**
 * A running worker: a BullMQ consumer and an outbox dispatcher, started and
 * stopped together.
 *
 * It is a library, not a process. Nothing here reads `process.argv`, registers a
 * signal handler, or calls `process.exit` — a platform module that installed a
 * `SIGTERM` handler would be deciding the shutdown behaviour of every host that
 * ever imports it, including the test runner. The entry point in `src/worker`
 * owns the process; this owns the resources.
 *
 * The registry is a parameter rather than an import, so the integration suite can
 * run a worker over its own definitions without those definitions existing in
 * the application's registry.
 */
export type JobsWorkerRuntime = Readonly<{
  queueName: string;
  dispatcherId: string;
  concurrency: number;
  /** Resolves once the worker has stopped consuming and released everything. */
  stop: () => Promise<void>;
}>;

export type StartJobsWorkerOptions = Readonly<{
  registry: JobRegistry;
  /** Overrides the configured concurrency. Used by tests that need exactly one. */
  concurrency?: number;
  /** Overridden only by tests that need a stable dispatcher identity. */
  dispatcherId?: string;
}>;

/**
 * Waits for an operation, but not forever.
 *
 * `worker.close()` has no timeout of its own: it waits for active jobs, and an
 * active job that ignores its abort signal would keep a deployment's rolling
 * restart waiting indefinitely. Answering `false` lets the caller escalate to a
 * forced close rather than hang.
 */
async function settledWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    return await Promise.race([operation.then(() => true), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startJobsWorkerRuntime(
  options: StartJobsWorkerOptions,
): Promise<JobsWorkerRuntime> {
  const configuration = getJobsConfiguration();

  if (!configuration.enabled) {
    throw new Error("Background jobs are not enabled.");
  }

  // Throws when `JOBS_REDIS_URL` is absent. A worker is exactly the caller that
  // cannot proceed without it, so this is the right place for the requirement.
  const { url, queuePrefix } = getJobsRedisConfiguration();
  const concurrency = options.concurrency ?? configuration.workerConcurrency;

  logJobEvent(JOB_LOG_LEVEL.INFO, JOBS_LOG_EVENT.WORKER_STARTED, {
    queueName: JOBS_QUEUE_NAME,
  });

  const connection = createWorkerConnection(url);
  const worker = new Worker(
    JOBS_QUEUE_NAME,
    createJobProcessor(options.registry),
    {
      connection,
      prefix: queuePrefix,
      concurrency,
    },
  );

  // Required, not optional: an unhandled `error` event terminates the process,
  // and a worker that dies on a Redis blip is worse than one that logs it.
  worker.on("error", (error: unknown) => {
    logJobEvent(
      JOB_LOG_LEVEL.WARN,
      JOBS_LOG_EVENT.QUEUE_WORKER_CONNECTION_FAILED,
      {
        queueName: JOBS_QUEUE_NAME,
        errorCode:
          error instanceof Error ? error.constructor.name : "UnknownError",
      },
    );
  });

  // A stalled job is one whose lock expired while it was supposedly running —
  // usually a process that was killed mid-attempt. BullMQ requeues it, which is
  // why handlers have to be idempotent.
  worker.on("stalled", (jobId: string) => {
    logJobEvent(JOB_LOG_LEVEL.WARN, JOBS_LOG_EVENT.JOB_STALLED, {
      queueName: JOBS_QUEUE_NAME,
      jobId,
      outcome: JOB_OUTCOME.RETRYING,
    });
  });

  let dispatcher: OutboxDispatcher;

  try {
    await worker.waitUntilReady();

    dispatcher = createOutboxDispatcher({
      registry: options.registry,
      ...(options.dispatcherId === undefined
        ? {}
        : { dispatcherId: options.dispatcherId }),
    });

    dispatcher.start();
  } catch (error) {
    // A failed start must not leave a half-open worker and a live connection
    // behind; a supervisor restarting the process would stack them up.
    await worker.close(true).catch(() => undefined);
    await closeJobsConnection(connection);

    throw error;
  }

  // The concurrency is not logged: it is not on the field allowlist, and a
  // number that is only meaningful next to a queue's depth does not earn a place
  // on it.
  logJobEvent(JOB_LOG_LEVEL.INFO, JOBS_LOG_EVENT.WORKER_READY, {
    queueName: JOBS_QUEUE_NAME,
  });

  let stopped: Promise<void> | undefined;

  async function shutdown(): Promise<void> {
    logJobEvent(JOB_LOG_LEVEL.INFO, JOBS_LOG_EVENT.WORKER_STOPPING, {
      queueName: JOBS_QUEUE_NAME,
    });

    // Order matters. Polling stops first so no new message is published while
    // the worker is draining; then the worker stops accepting and finishes what
    // it holds; then the connections go.
    await dispatcher.stop();

    const closedInTime = await settledWithin(
      worker.close(),
      configuration.workerShutdownTimeoutMs,
    );

    if (!closedInTime) {
      // The budget is spent. Whatever is still running loses its lock and comes
      // back as a stalled job — which is safe, because handlers are idempotent
      // — and that is strictly better than never exiting.
      await worker.close(true).catch(() => undefined);
    }

    await closeJobQueue();
    await closeJobsConnection(connection);

    logJobEvent(JOB_LOG_LEVEL.INFO, JOBS_LOG_EVENT.WORKER_STOPPED, {
      queueName: JOBS_QUEUE_NAME,
      outcome: closedInTime ? JOB_OUTCOME.SUCCEEDED : JOB_OUTCOME.TIMED_OUT,
    });
  }

  return {
    queueName: JOBS_QUEUE_NAME,
    dispatcherId: dispatcher.id,
    concurrency,
    // Idempotent: a second signal, or a test that stops twice, joins the
    // shutdown already in progress instead of closing a closed worker.
    stop: () => (stopped ??= shutdown()),
  };
}
