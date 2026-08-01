/**
 * The complete allowlist of fields a background-jobs log line may carry.
 *
 * A job line is the single most tempting place in the system to print the thing
 * that would explain the failure: the payload, the result, the address the mail
 * was going to, the exception. Every one of those is durable, is shipped off the
 * box, and outlives the incident. So the field set is closed, the closure is
 * enforced here rather than at each call site, and anything outside it is
 * dropped rather than trusted to be harmless.
 *
 * A line may carry an identity, a counter, a duration, and a stable code. It may
 * never carry a payload, a result, an email address, an IP address, a token, a
 * header, raw baggage, a Redis URL, a database URL, an exception message, or a
 * stack trace.
 */
export const JOB_OUTCOME = {
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  RETRYING: "retrying",
  TIMED_OUT: "timed-out",
  DEAD_LETTERED: "dead-lettered",
  SKIPPED: "skipped",
  REPLAYED: "replayed",
} as const;

export type JobOutcome = (typeof JOB_OUTCOME)[keyof typeof JOB_OUTCOME];

export type JobLogFields = Readonly<{
  jobName?: string;
  jobVersion?: number;
  jobId?: string;
  outboxId?: string;
  queueName?: string;
  attempt?: number;
  maxAttempts?: number;
  correlationId?: string;
  causationId?: string;
  durationMs?: number;
  outcome?: JobOutcome;
  errorCode?: string;
  delayMs?: number;
  batchSize?: number;
}>;

export type JobLogInput = Readonly<{
  jobName?: string | undefined;
  jobVersion?: number | undefined;
  jobId?: string | undefined;
  outboxId?: string | undefined;
  queueName?: string | undefined;
  attempt?: number | undefined;
  maxAttempts?: number | undefined;
  correlationId?: string | undefined;
  causationId?: string | undefined;
  durationMs?: number | undefined;
  outcome?: JobOutcome | undefined;
  errorCode?: string | undefined;
  delayMs?: number | undefined;
  batchSize?: number | undefined;
}>;

/**
 * The field names a line may carry, in one list.
 *
 * Exported so a contract test can assert that the allowlist and the documented
 * set are the same list rather than two lists that agree today.
 */
export const JOB_LOG_FIELD_NAMES = [
  "jobName",
  "jobVersion",
  "jobId",
  "outboxId",
  "queueName",
  "attempt",
  "maxAttempts",
  "correlationId",
  "causationId",
  "durationMs",
  "outcome",
  "errorCode",
  "delayMs",
  "batchSize",
] as const;

/**
 * Builds the payload for a jobs event.
 *
 * Absent values are omitted rather than serialized as `null`, so a line never
 * claims to know something it does not, and anything the input carries beyond
 * the allowlist is dropped here rather than at each call site.
 */
export function toJobLogFields(input: JobLogInput): JobLogFields {
  const source = input as Record<string, unknown>;
  const fields: Record<string, unknown> = {};

  for (const name of JOB_LOG_FIELD_NAMES) {
    const value = source[name];

    if (value !== undefined) {
      fields[name] = value;
    }
  }

  return fields as JobLogFields;
}
