import { parseEnvironment } from "./parse";
import { jobsEnvironmentSchema, type JobsEnvironment } from "./schema";

/**
 * The variables this reader looks up, named for documentation. The index
 * signature is what lets `process.env` be passed directly: none of these names
 * is declared on `ProcessEnv`, so a purely optional shape would be rejected as
 * having nothing in common with it.
 */
type JobsEnvironmentSource = Readonly<Record<string, string | undefined>> & {
  readonly JOBS_ENABLED?: string;
  readonly JOBS_REDIS_URL?: string;
  readonly JOBS_QUEUE_PREFIX?: string;
  readonly JOBS_WORKER_CONCURRENCY?: string;
  readonly JOBS_WORKER_SHUTDOWN_TIMEOUT_MS?: string;
  readonly OUTBOX_BATCH_SIZE?: string;
  readonly OUTBOX_POLL_INTERVAL_MS?: string;
  readonly OUTBOX_LEASE_MS?: string;
  readonly OUTBOX_MAX_PUBLISH_ATTEMPTS?: string;
  readonly OUTBOX_BACKOFF_BASE_MS?: string;
  readonly JOBS_TEST_RUN_ID?: string;
};

const JOBS_VARIABLE_NAMES = [
  "JOBS_ENABLED",
  "JOBS_REDIS_URL",
  "JOBS_QUEUE_PREFIX",
  "JOBS_WORKER_CONCURRENCY",
  "JOBS_WORKER_SHUTDOWN_TIMEOUT_MS",
  "OUTBOX_BATCH_SIZE",
  "OUTBOX_POLL_INTERVAL_MS",
  "OUTBOX_LEASE_MS",
  "OUTBOX_MAX_PUBLISH_ATTEMPTS",
  "OUTBOX_BACKOFF_BASE_MS",
  "JOBS_TEST_RUN_ID",
] as const;

/**
 * Reads the optional background-jobs configuration.
 *
 * Like the Redis reader and unlike the server and database readers, this one is
 * never called at import time. `index.server.ts` exports no `jobsEnv`, because
 * doing so would make a queue part of startup validation and a project that
 * never enables jobs would still be paying for it.
 *
 * A source with no jobs variable at all is valid and yields a disabled
 * configuration. An absent variable is omitted rather than passed as
 * `undefined`, so a schema default applies instead of being overwritten.
 */
export function readJobsEnvironment(
  source: JobsEnvironmentSource = process.env,
): JobsEnvironment {
  const values: Record<string, string> = {};

  for (const name of JOBS_VARIABLE_NAMES) {
    const value = source[name];

    if (value !== undefined) {
      values[name] = value;
    }
  }

  return parseEnvironment("jobs", jobsEnvironmentSchema, values);
}
