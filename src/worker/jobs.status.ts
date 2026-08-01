import { loadWorkerEnvironment, WORKER_EXIT_CODE } from "./bootstrap";

/**
 * What the outbox looks like right now, from PostgreSQL alone.
 *
 * Started with `pnpm jobs:status`. It deliberately does not contact Redis: the
 * moment you most want this command is the moment Redis is down, and a status
 * command that cannot answer during an outage is not a status command. Every
 * number here comes from the durable source, which is the one that matters —
 * Redis can be lost entirely without losing a row.
 *
 * The output is a structured log line rather than printed text. That is not
 * decoration: the same redaction and the same field allowlist apply, so a
 * status command cannot become the place a connection string is echoed to a
 * terminal and pasted into an issue.
 */
async function main(): Promise<void> {
  loadWorkerEnvironment();

  const [jobs, observability, databaseModule] = await Promise.all([
    import("@/platform/jobs/index.server"),
    import("@/platform/observability/index.server"),
    import("@/platform/database/index.server"),
  ]);

  const { logger } = observability;
  const { database } = databaseModule;
  const configuration = jobs.getJobsConfiguration();

  try {
    const now = new Date();

    const [pending, due, leased, deadLettered, published, receipts] =
      await Promise.all([
        database.outboxMessage.count({
          where: { publishedAt: null, deadLetteredAt: null },
        }),
        database.outboxMessage.count({
          where: {
            publishedAt: null,
            deadLetteredAt: null,
            availableAt: { lte: now },
          },
        }),
        database.outboxMessage.count({
          where: { publishedAt: null, lockedUntil: { gt: now } },
        }),
        database.outboxMessage.count({
          where: { deadLetteredAt: { not: null } },
        }),
        database.outboxMessage.count({ where: { publishedAt: { not: null } } }),
        database.jobExecutionReceipt.count(),
      ]);

    logger.info(
      {
        module: "jobs",
        operation: "status",
        // Booleans and counts only. The queue prefix is included because it is
        // the one piece of configuration you need to look at two deployments
        // and tell whether they share a queue; the URL never is.
        jobsEnabled: configuration.enabled,
        queueConfigured: jobs.isJobQueueConfigured(),
        queuePrefix: configuration.queuePrefix,
        registeredJobs: jobs.JOB_REGISTRY.identities.length,
        outboxPending: pending,
        outboxDue: due,
        outboxLeased: leased,
        outboxDeadLettered: deadLettered,
        outboxPublished: published,
        executionReceipts: receipts,
      },
      "jobs.status",
    );
  } finally {
    await database.$disconnect();
  }
}

void main().catch(() => {
  process.exitCode = WORKER_EXIT_CODE.FAILED;
});
