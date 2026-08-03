/**
 * Every machine-readable code the operational health contracts can answer.
 *
 * One list, closed, and public. These codes are the part of this platform that
 * something outside the repository depends on: a load balancer rule, a
 * deployment gate, an alert, a runbook. Changing one is a breaking change to an
 * operational integration, which is why they live in a single file instead of
 * being spelled out at each call site.
 *
 * Three properties are load-bearing:
 *
 * - They are **language-neutral identifiers**, never prose. Nothing here is
 *   shown to a person who is not reading a machine's output, so there is nothing
 *   to translate and no sentence to reword.
 * - They are **never derived from an error**. Not from a message, not from a
 *   class name, not from a provider's code. A code that came out of an exception
 *   would carry whatever the exception carried, and the set would stop being
 *   closed the first time a driver changed its wording.
 * - They **name a condition, not a provider**. `STORAGE_UNAVAILABLE` says the
 *   bucket could not be reached; it does not say which bucket, which endpoint,
 *   or which vendor refused.
 *
 * Three of them are also owned elsewhere, and deliberately restated here:
 * `DATABASE_UNAVAILABLE` by `@/platform/database`, `REDIS_UNAVAILABLE` by
 * `@/platform/redis`, and `JOBS_REDIS_UNAVAILABLE` by `@/platform/jobs`. The
 * owning area needs its own constant so it can answer without depending on this
 * platform, and this platform needs the public list to be complete in one place.
 * A unit test asserts the two spellings are the same string, so they cannot
 * drift apart unnoticed.
 */
export const HEALTH_CODE = {
  /** The process is running and serving. It is the only liveness answer. */
  PROCESS_ALIVE: "PROCESS_ALIVE",

  /** Every required dependency answered. */
  READY: "READY",

  /** At least one required dependency did not. */
  NOT_READY: "NOT_READY",

  /** PostgreSQL did not answer within its budget. */
  DATABASE_UNAVAILABLE: "DATABASE_UNAVAILABLE",

  /** Redis is enabled and did not answer. A disabled Redis never reports this. */
  REDIS_UNAVAILABLE: "REDIS_UNAVAILABLE",

  /** The object store is enabled and could not be reached. Worth retrying. */
  STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE",

  /**
   * The object store answered and refused: the bucket does not exist, the
   * credentials are rejected, or the variables do not parse. Restarting will not
   * fix it, so it is a distinct code from the one above.
   */
  STORAGE_MISCONFIGURED: "STORAGE_MISCONFIGURED",

  /** The worker's dependencies all answered. */
  WORKER_READY: "WORKER_READY",

  /** The worker is configured to run but a dependency did not answer. */
  WORKER_NOT_READY: "WORKER_NOT_READY",

  /**
   * The worker cannot run as configured — background jobs are switched off, or
   * no queue address is set. A supervisor should stop restarting it.
   */
  WORKER_MISCONFIGURED: "WORKER_MISCONFIGURED",

  /** The queue's Redis did not answer. Only a worker process reports this. */
  JOBS_REDIS_UNAVAILABLE: "JOBS_REDIS_UNAVAILABLE",
} as const;

export type HealthCode = (typeof HEALTH_CODE)[keyof typeof HEALTH_CODE];

export const HEALTH_CODES: readonly HealthCode[] = Object.freeze(
  Object.values(HEALTH_CODE),
);

/** `true` when a value is one of the published codes. */
export function isHealthCode(value: unknown): value is HealthCode {
  return (
    typeof value === "string" &&
    (HEALTH_CODES as readonly string[]).includes(value)
  );
}
