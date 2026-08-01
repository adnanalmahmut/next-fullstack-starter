/**
 * Why an attempt failed, in a form that decides whether to try again.
 *
 * There are only two kinds of failure worth distinguishing at this level.
 * A *retryable* failure is one where the same message might succeed later: the
 * database was unreachable, a provider returned 503, the network went away.
 * A *permanent* failure is one where the same message cannot ever succeed: the
 * payload does not match its schema, the job is not registered, the version is
 * not supported. Retrying the second kind is not resilience — it is spending the
 * whole attempt budget to arrive at the same answer, later, in a bigger log.
 *
 * The default is retryable. A plain `Error` from a handler means "try again",
 * because most failures genuinely are transient and the alternative default
 * would silently drop work.
 */
export const JOB_FAILURE_CODE = {
  INVALID_ENVELOPE: "invalid-envelope",
  UNKNOWN_JOB: "unknown-job",
  UNSUPPORTED_VERSION: "unsupported-version",
  INVALID_PAYLOAD: "invalid-payload",
  INVALID_RESULT: "invalid-result",
  TIMED_OUT: "timed-out",
  HANDLER_FAILED: "handler-failed",
} as const;

export type JobFailureCode =
  (typeof JOB_FAILURE_CODE)[keyof typeof JOB_FAILURE_CODE];

export const JOB_FAILURE_CODES: readonly JobFailureCode[] =
  Object.values(JOB_FAILURE_CODE);

/**
 * A failure that will not be fixed by trying again.
 *
 * The worker turns this into BullMQ's `UnrecoverableError`, which stops the
 * retries and moves the job into the failed set where it can be looked at. The
 * message is for a developer reading a stack in a test; it is never logged.
 */
export class PermanentJobError extends Error {
  readonly code: JobFailureCode;

  constructor(code: JobFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentJobError";
    this.code = code;
    Object.setPrototypeOf(this, PermanentJobError.prototype);
  }
}

/**
 * An attempt that ran out of time.
 *
 * Whether it is permanent is a property of the job, not of the timeout, so this
 * carries the definition's answer rather than deciding for it.
 */
export class JobTimeoutError extends Error {
  readonly code = JOB_FAILURE_CODE.TIMED_OUT;
  readonly retryable: boolean;

  constructor(retryable: boolean, options?: ErrorOptions) {
    super("The job attempt exceeded its timeout.", options);
    this.name = "JobTimeoutError";
    this.retryable = retryable;
    Object.setPrototypeOf(this, JobTimeoutError.prototype);
  }
}

export function isPermanentJobFailure(error: unknown): boolean {
  if (error instanceof PermanentJobError) {
    return true;
  }

  return error instanceof JobTimeoutError && !error.retryable;
}

/**
 * The stable code for a failure.
 *
 * Anything unrecognised becomes `handler-failed`. The caught value is
 * deliberately not read beyond its type: a message is the most common way a
 * payload, an address, or a connection string escapes into a log line.
 */
export function toJobFailureCode(error: unknown): JobFailureCode {
  if (error instanceof PermanentJobError) {
    return error.code;
  }

  if (error instanceof JobTimeoutError) {
    return JOB_FAILURE_CODE.TIMED_OUT;
  }

  return JOB_FAILURE_CODE.HANDLER_FAILED;
}
