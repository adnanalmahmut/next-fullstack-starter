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
 *  3. start telemetry and error monitoring for the `worker` process type, both
 *     optional and both no-ops when switched off;
 *  4. build the worker configuration, which is where a missing `JOBS_REDIS_URL`
 *     is caught;
 *  5. open the BullMQ connections and start the consumer;
 *  6. start the outbox dispatcher and arm the backlog gauges;
 *  7. report readiness;
 *  8. wait for `SIGINT` or `SIGTERM`;
 *  9. stop polling, drain within the shutdown budget, close the worker, the
 *     queue, and the connections;
 * 10. flush telemetry and error reports within their budgets, shut both down,
 *     and disconnect Prisma.
 *
 * Telemetry is started here rather than inside the platform for the same reason
 * the signal handlers are: a worker is a process, and deciding what a process
 * exports and when it flushes is a process concern. It is also why an exporter
 * that cannot reach its collector at shutdown does not change the exit code — the
 * jobs either ran or they did not, and a lost span does not change which.
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

  // Before the first job is consumed, so the first execution is traced rather
  // than dropped into a provider that does not exist yet. Neither call throws:
  // both contain their own failures and answer with a stable status.
  await observability.startProductionTelemetry({
    processType: observability.TELEMETRY_PROCESS_TYPE.WORKER,
  });
  await observability.startErrorMonitor({
    processType: observability.TELEMETRY_PROCESS_TYPE.WORKER,
  });

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

  // After the worker has stopped and before the database goes: a job's last span
  // and the attempt counters it produced are still buffered, and this is the only
  // moment they can still leave. Every call below is bounded by its own timeout and
  // swallows its failures, so a collector that has gone away cannot hold the
  // process open or change an exit code that has already been decided.
  await observability.forceFlushProductionTelemetry();
  await observability.flushErrorMonitor(
    observability.TELEMETRY_SHUTDOWN_TIMEOUT_MS,
  );
  await observability.shutdownErrorMonitor();
  await observability.shutdownProductionTelemetry();

  await databaseModule.database.$disconnect();
}

void main().catch(() => {
  // The failure has already been logged by whatever produced it, and a raw
  // stack on stderr is the one place a connection string reliably appears.
  process.exitCode = WORKER_EXIT_CODE.FAILED;
});
