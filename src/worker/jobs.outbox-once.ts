import { loadWorkerEnvironment, WORKER_EXIT_CODE } from "./bootstrap";

/**
 * One dispatch pass, then exit.
 *
 * Started with `pnpm jobs:outbox:once`. It claims a single batch, publishes it,
 * and stops — no polling loop and no consumer. Two uses justify it: draining the
 * backlog from a scheduled task on a platform where a long-lived worker is
 * awkward, and answering "is publishing actually working" during an incident
 * without starting something that has to be stopped again.
 *
 * It shares the dispatcher with the worker, so what it proves is what the worker
 * does.
 */
async function main(): Promise<void> {
  loadWorkerEnvironment();

  const [jobs, observability, databaseModule] = await Promise.all([
    import("@/platform/jobs/index.server"),
    import("@/platform/observability/index.server"),
    import("@/platform/database/index.server"),
  ]);

  const { logger } = observability;

  if (!jobs.isJobQueueConfigured()) {
    logger.error(
      { module: "jobs", operation: "outbox-once" },
      jobs.JOBS_LOG_EVENT.OUTBOX_PUBLISH_FAILED,
    );

    process.exitCode = WORKER_EXIT_CODE.MISCONFIGURED;

    return;
  }

  const dispatcher = jobs.createOutboxDispatcher({
    registry: jobs.JOB_REGISTRY,
  });

  try {
    const summary = await dispatcher.runOnce();

    logger.info(
      jobs.toJobLogFields({ batchSize: summary.claimed }),
      jobs.JOBS_LOG_EVENT.OUTBOX_PUBLISHED,
    );
  } finally {
    // The dispatcher never started polling, but the queue it published through
    // owns a connection, and an open connection keeps the process alive.
    await jobs.closeJobQueue();
    await databaseModule.database.$disconnect();
  }
}

void main().catch(() => {
  process.exitCode = WORKER_EXIT_CODE.FAILED;
});
