import { loadWorkerEnvironment, WORKER_EXIT_CODE } from "./bootstrap";

/**
 * Whether this worker deployment could actually do its job right now.
 *
 * Started with `pnpm jobs:health`. It is a one-shot command: it opens bounded
 * connections, asks two questions, closes everything, writes one line, and sets
 * an exit code. No port is opened, no job is enqueued, no job is executed, no
 * outbox row is written or read, and no receipt is created — a health check that
 * ran real work would leave real effects behind every time an operator ran it.
 *
 * ## Why it is separate from `jobs:status`
 *
 * `jobs:status` answers "what is in the outbox", from PostgreSQL alone, and it
 * deliberately never contacts Redis — the moment you most want it is the moment
 * Redis is down. That makes it the wrong command for readiness, because a worker
 * whose queue is unreachable would report a perfectly healthy outbox. Its meaning
 * is unchanged by this file.
 *
 * This command answers a different question and gives its answer through the exit
 * code, which is what a deployment gate, a container health check, or a
 * supervisor can act on:
 *
 * | Exit | Meaning |
 * | ---- | ------- |
 * | `0` | ready: jobs enabled, queue addressed, PostgreSQL and queue Redis both answered |
 * | `1` | not ready: configured correctly, but something did not answer — may recover |
 * | `78` | misconfigured: `JOBS_ENABLED=false` or no `JOBS_REDIS_URL` — will never start |
 *
 * `JOBS_ENABLED=false` is a misconfiguration *here* and normal everywhere else.
 * In a worker deployment it means the process was started to consume a queue it
 * has been told not to consume, so reporting ready would be reporting a
 * deployment mistake as success. It never makes the web process unready.
 *
 * The composition happens in this file rather than in the health platform on
 * purpose. The health platform's shared entry point deliberately reaches neither
 * `@/platform/jobs` nor `@/platform/database`: if it did, background jobs would
 * become a dependency of the endpoint a load balancer calls, and a generated
 * project could no longer delete the jobs area without editing the health area.
 * This process already depends on both, so this is where they meet. The two
 * mappings below are the price, and the jobs integration suite runs this command
 * as a subprocess and asserts all three exit codes, which covers them better than
 * a unit test of a mapper would.
 *
 * Constructing the job registry is part of the check by construction, with no line
 * of its own: `createJobRegistry` validates the registry while
 * `@/platform/jobs/index.server` is being evaluated, so a registry that cannot be
 * built rejects the import above and this command exits non-zero instead of
 * reporting a ready worker.
 */
async function main(): Promise<void> {
  loadWorkerEnvironment();

  const [jobs, health, databaseModule] = await Promise.all([
    import("@/platform/jobs/index.server"),
    import("@/platform/health/index.server"),
    import("@/platform/database/index.server"),
  ]);

  const { checkDatabaseHealth, database, DATABASE_HEALTH_STATUS } =
    databaseModule;

  try {
    const report = await health.checkWorkerReadiness({
      jobsEnabled: jobs.isJobsEnabled(),
      queueConfigured: jobs.isJobQueueConfigured(),
      checkDatabase: async () => {
        const result = await checkDatabaseHealth();

        return result.status === DATABASE_HEALTH_STATUS.HEALTHY
          ? health.HEALTHY_DEPENDENCY
          : health.unhealthyDependency(health.HEALTH_CODE.DATABASE_UNAVAILABLE);
      },
      checkQueue: async () => {
        const result = await jobs.checkJobsQueueHealth();

        if (result.status === jobs.JOBS_QUEUE_HEALTH_STATUS.HEALTHY) {
          return health.HEALTHY_DEPENDENCY;
        }

        if (result.status === jobs.JOBS_QUEUE_HEALTH_STATUS.DISABLED) {
          return health.DISABLED_DEPENDENCY;
        }

        return health.unhealthyDependency(
          health.HEALTH_CODE.JOBS_REDIS_UNAVAILABLE,
        );
      },
    });

    health.logWorkerReadiness(report);

    process.exitCode =
      report.status === health.WORKER_READINESS_STATUS.READY
        ? WORKER_EXIT_CODE.OK
        : report.status === health.WORKER_READINESS_STATUS.MISCONFIGURED
          ? WORKER_EXIT_CODE.MISCONFIGURED
          : WORKER_EXIT_CODE.FAILED;
  } finally {
    // The queue probe closes its own connection; this closes the one this
    // process opened. A health command that left a pool behind would be the
    // wrong tool to run repeatedly during an incident.
    await database.$disconnect();
  }
}

void main().catch(() => {
  // The failure has already been logged by whatever produced it, and a raw stack
  // on stderr is the one place a connection string reliably appears.
  process.exitCode = WORKER_EXIT_CODE.FAILED;
});
