import { serverEnv } from "@/config/env/index.server";
import { readJobsEnvironment } from "@/config/env/read-jobs";
import type { JobsEnvironment } from "@/config/env/schema";

/**
 * The resolved background-jobs configuration, read lazily.
 *
 * Nothing here runs at import time. A module that imports this file does not
 * read the environment, does not validate a URL, and certainly does not open a
 * socket; all of that waits for the first call. That is what makes background
 * jobs genuinely optional rather than optional-in-principle.
 *
 * The two levels are kept apart deliberately, and the split is the contract:
 *
 * - `getJobsConfiguration()` answers whether work may be *recorded*. Writing an
 *   outbox row is an insert inside the caller's transaction, so it needs no
 *   Redis address at all.
 * - `getJobsRedisConfiguration()` answers where the *queue* lives, and is the
 *   only function that requires `JOBS_REDIS_URL`. Nothing on the request path
 *   should ever call it.
 */
export type OutboxConfiguration = Readonly<{
  batchSize: number;
  pollIntervalMs: number;
  leaseMs: number;
  maxPublishAttempts: number;
  backoffBaseMs: number;
}>;

export type JobsConfiguration = Readonly<{
  enabled: boolean;
  queuePrefix: string;
  workerConcurrency: number;
  workerShutdownTimeoutMs: number;
  outbox: OutboxConfiguration;
}>;

/**
 * Everything needed to build a connection, and nothing else.
 *
 * It is a separate type rather than an optional field on `JobsConfiguration` so
 * that a caller holding a `JobsConfiguration` structurally cannot reach a URL,
 * and so a reviewer can see at a glance which call sites need Redis.
 */
export type JobsRedisConfiguration = Readonly<{
  url: string;
  queuePrefix: string;
}>;

type JobsState = {
  configuration?: JobsConfiguration;
  environment?: JobsEnvironment;
};

/**
 * Memoized per process, and held on `globalThis` for the same reason the Prisma
 * client is: a development reload re-evaluates the module, and a second
 * resolution would give the reloaded code a different queue prefix from the one
 * the already-queued jobs were written under.
 */
const globalForJobsConfig = globalThis as typeof globalThis & {
  jobsConfigurationState?: JobsState;
};

function state(): JobsState {
  globalForJobsConfig.jobsConfigurationState ??= {};

  return globalForJobsConfig.jobsConfigurationState;
}

function environment(): JobsEnvironment {
  const current = state();

  current.environment ??= readJobsEnvironment();

  return current.environment;
}

function generateTestRunId(): string {
  return `run-${crypto.randomUUID()}`;
}

/**
 * The prefix every queue key of this process shares.
 *
 * Under test a run identifier is always part of it: one is taken from
 * `JOBS_TEST_RUN_ID` when the runner supplies it and generated otherwise, so two
 * runs against the same Redis can never consume each other's jobs even when
 * nobody remembered to set a variable.
 *
 * The colons are added here rather than being allowed inside the configured
 * value, so a deployment cannot widen its own prefix into another one's.
 */
function resolveQueuePrefix(values: JobsEnvironment): string {
  if (serverEnv.APP_ENV !== "test") {
    return values.JOBS_QUEUE_PREFIX;
  }

  const testRunId = values.JOBS_TEST_RUN_ID ?? generateTestRunId();

  return `${values.JOBS_QUEUE_PREFIX}:test:${testRunId}`;
}

export function getJobsConfiguration(): JobsConfiguration {
  const current = state();

  if (current.configuration) {
    return current.configuration;
  }

  const values = environment();

  current.configuration = {
    enabled: values.JOBS_ENABLED,
    queuePrefix: resolveQueuePrefix(values),
    workerConcurrency: values.JOBS_WORKER_CONCURRENCY,
    workerShutdownTimeoutMs: values.JOBS_WORKER_SHUTDOWN_TIMEOUT_MS,
    outbox: {
      batchSize: values.OUTBOX_BATCH_SIZE,
      pollIntervalMs: values.OUTBOX_POLL_INTERVAL_MS,
      leaseMs: values.OUTBOX_LEASE_MS,
      maxPublishAttempts: values.OUTBOX_MAX_PUBLISH_ATTEMPTS,
      backoffBaseMs: values.OUTBOX_BACKOFF_BASE_MS,
    },
  };

  return current.configuration;
}

/** `true` only when jobs are explicitly enabled. Never opens a connection. */
export function isJobsEnabled(): boolean {
  return getJobsConfiguration().enabled;
}

/**
 * Where the queue lives.
 *
 * Called only by the code that builds a `Queue`, a `Worker`, or the dispatcher.
 * It throws rather than returning `null`, because every one of those callers has
 * already decided it needs Redis, and a `null` would only be turned into the
 * same failure one line later — or, worse, silently skipped.
 *
 * The message names the variable and never the value: a connection string is a
 * credential, and a misconfiguration is exactly when it would otherwise be
 * printed into a log.
 */
export function getJobsRedisConfiguration(): JobsRedisConfiguration {
  const configuration = getJobsConfiguration();

  if (!configuration.enabled) {
    throw new Error("Background jobs are not enabled.");
  }

  const url = environment().JOBS_REDIS_URL;

  if (url === undefined) {
    throw new Error("JOBS_REDIS_URL is required to reach the job queue.");
  }

  return { url, queuePrefix: configuration.queuePrefix };
}

/** `true` when a queue could be built right now. Never opens a connection. */
export function isJobQueueConfigured(): boolean {
  return (
    getJobsConfiguration().enabled && environment().JOBS_REDIS_URL !== undefined
  );
}

/**
 * Drops the memoized configuration.
 *
 * Exported for tests that change the environment between cases, and for nothing
 * else: application code reads one configuration for the lifetime of a process.
 */
export function resetJobsConfiguration(): void {
  delete globalForJobsConfig.jobsConfigurationState;
}
