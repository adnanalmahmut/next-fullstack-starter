import { loadWorkerEnvironment, WORKER_EXIT_CODE } from "./bootstrap";

/**
 * The background worker process.
 *
 * It is a separate process, started with `pnpm jobs:worker`, and it is not part
 * of Next.js in any sense: no route imports it, no Server Action starts it, the
 * `dev`, `build`, and `start` scripts do not run it, and it must never be
 * launched inside a serverless function, where the platform would freeze it
 * between invocations and its jobs would stall.
 *
 * This file owns exactly three things the platform module refuses to own: the
 * process's signal handlers, its exit code, and the Prisma disconnect. Anything
 * a library installs on `process` is installed on every host that imports it,
 * including the test runner, so the platform stays a library and the process
 * concerns live here.
 *
 * Startup sequence:
 *
 *  1. load `.env*` and align `NODE_ENV` (before any application import);
 *  2. refuse to start unless `JOBS_ENABLED` is true;
 *  3. build the worker configuration, which is where a missing `JOBS_REDIS_URL`
 *     is caught;
 *  4. open the BullMQ connections and start the consumer;
 *  5. start the outbox dispatcher;
 *  6. report readiness;
 *  7. wait for `SIGINT` or `SIGTERM`;
 *  8. stop polling, drain within the shutdown budget, close the worker, the
 *     queue, the connections, and Prisma.
 */
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

async function main(): Promise<void> {
  loadWorkerEnvironment();

  const [jobs, observability, databaseModule] = await Promise.all([
    import("@/platform/jobs/index.server"),
    import("@/platform/observability/index.server"),
    import("@/platform/database/index.server"),
  ]);

  const { logger } = observability;

  if (!jobs.isJobsEnabled()) {
    // Refusing is the correct behaviour, not a failure: a deployment that has
    // not opted into background jobs should not get a worker that quietly polls
    // an empty queue forever.
    logger.error(
      { module: "jobs", operation: "worker" },
      jobs.JOBS_LOG_EVENT.WORKER_STOPPED,
    );

    process.exitCode = WORKER_EXIT_CODE.MISCONFIGURED;

    return;
  }

  const runtime = await jobs.startJobsWorkerRuntime({
    registry: jobs.JOB_REGISTRY,
  });

  let stopping = false;

  const finished = new Promise<void>((resolve) => {
    async function shutdown(): Promise<void> {
      if (stopping) {
        // A second signal is an operator saying "I meant it". The graceful stop
        // is already under way and bounded by its own timeout; this stops
        // waiting for it. Anything still running loses its lock and comes back
        // as a stalled job, which is safe because handlers are idempotent.
        process.exitCode = WORKER_EXIT_CODE.FAILED;
        resolve();

        return;
      }

      stopping = true;

      try {
        await runtime.stop();
      } catch {
        // A shutdown that fails must still be a shutdown. The failure is
        // reported through the exit code; nothing about it belongs in a log
        // line beyond what `stop` already wrote.
        process.exitCode = WORKER_EXIT_CODE.FAILED;
      }

      resolve();
    }

    for (const signal of SHUTDOWN_SIGNALS) {
      process.on(signal, () => {
        void shutdown();
      });
    }
  });

  await finished;

  await databaseModule.database.$disconnect();
}

void main().catch(() => {
  // The failure has already been logged by whatever produced it, and a raw
  // stack on stderr is the one place a connection string reliably appears.
  process.exitCode = WORKER_EXIT_CODE.FAILED;
});
