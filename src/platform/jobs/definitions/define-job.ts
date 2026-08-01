import { z } from "zod";

import { checkJobPayload, isJsonValue } from "./job-envelope";
import { isValidJobName, isValidJobVersion, jobIdentity } from "./job-identity";

/**
 * The typed declaration of one background job.
 *
 * A definition is the whole contract: what the job is called, which shape of it
 * this is, what a valid payload looks like, how many times it may be retried and
 * how far apart, how long one attempt may run, how a repeat delivery is
 * recognised, and what it actually does. Nothing about that is left to the call
 * site that enqueues it and nothing to the worker that runs it.
 *
 * Every bound below is closed on both ends. An unbounded `attempts` is an
 * infinite retry loop with extra steps, and an unbounded `timeoutMs` is a worker
 * slot that never comes back.
 */
export const JOB_BACKOFF_TYPE = {
  EXPONENTIAL: "exponential",
  FIXED: "fixed",
} as const;

export type JobBackoffType =
  (typeof JOB_BACKOFF_TYPE)[keyof typeof JOB_BACKOFF_TYPE];

export const JOB_BACKOFF_TYPES: readonly JobBackoffType[] =
  Object.values(JOB_BACKOFF_TYPE);

export const MIN_JOB_ATTEMPTS = 1;
export const MAX_JOB_ATTEMPTS = 20;

export const MIN_JOB_BACKOFF_DELAY_MS = 100;
export const MAX_JOB_BACKOFF_DELAY_MS = 3_600_000;

export const MIN_JOB_TIMEOUT_MS = 100;
export const MAX_JOB_TIMEOUT_MS = 600_000;

export type JobBackoff = Readonly<{
  type: JobBackoffType;
  delayMs: number;
}>;

/**
 * How a repeat delivery of the same work is recognised.
 *
 * The function receives the validated payload and returns the *domain's* notion
 * of "the same operation" — an order identifier, a user identifier and a target
 * state, whatever makes two deliveries equivalent. It is not the BullMQ job id
 * and not the outbox id: both of those are transport identifiers, and a redriven
 * message legitimately gets a new one.
 *
 * The returned value is never stored as given; it is hashed into an execution
 * key, so a domain key may safely contain an identifier that must not appear in
 * a database column or a log line.
 */
export type JobIdempotency<TPayload> = Readonly<{
  key: (payload: TPayload) => string;
}>;

/**
 * What a handler is told about the attempt it is running.
 *
 * Identifiers and counters only. There is no request, no headers, no cookies, no
 * actor, and no database client: a handler that needs the database asks for a
 * transaction through `runDatabaseJobOnce`, which is what makes the effect
 * idempotent rather than merely retried.
 */
export type JobExecutionContext = Readonly<{
  jobName: string;
  jobVersion: number;
  jobId: string;
  outboxId: string;
  attempt: number;
  maxAttempts: number;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  /** The hashed, opaque key a handler passes to `runDatabaseJobOnce`. */
  executionKey: string;
}>;

export type JobHandlerArguments<TPayload> = Readonly<{
  payload: TPayload;
  /**
   * Aborted when the job's timeout elapses.
   *
   * A handler is expected to pass it on to anything that accepts one. Ignoring
   * it does not make the timeout softer — the attempt still fails — it only
   * means the work keeps running with nobody waiting for it.
   */
  signal: AbortSignal;
  context: JobExecutionContext;
}>;

export type JobHandler<TPayload, TResult> = (
  args: JobHandlerArguments<TPayload>,
) => Promise<TResult>;

/**
 * The type-erased view of a definition.
 *
 * The registry holds jobs of many different payload types in one collection, and
 * a worker resolves one of them from a string. Neither can be expressed with the
 * concrete generic parameters still attached, so `defineJob` builds this
 * closure-backed view once and the typed surface stays for call sites.
 *
 * It is exported because the registry and the processor are typed against it,
 * and used by nothing else.
 */
export type JobRuntime = Readonly<{
  name: string;
  version: number;
  identity: string;
  attempts: number;
  backoff: JobBackoff;
  timeoutMs: number;
  timeoutRetryable: boolean;
  parsePayload: (
    value: unknown,
  ) => Readonly<{ ok: true; payload: unknown } | { ok: false }>;
  parseResult: (
    value: unknown,
  ) => Readonly<{ ok: true; result: unknown } | { ok: false }>;
  idempotencyKey: (payload: unknown) => string;
  run: (args: {
    payload: unknown;
    signal: AbortSignal;
    context: JobExecutionContext;
  }) => Promise<unknown>;
}>;

/**
 * The declaration a call site holds.
 *
 * The payload has two types, not one, and the distinction matters at exactly one
 * place: a schema with a `.default()` accepts less than it produces. The caller
 * supplies `TPayloadInput` — what the schema will accept — and the handler
 * receives `TPayload`, what the schema produced. Collapsing them would force
 * every caller to spell out the defaults its own schema was written to supply.
 */
export type JobDefinition<
  TPayload,
  TResult,
  TPayloadInput = TPayload,
> = Readonly<{
  name: string;
  version: number;
  identity: string;
  attempts: number;
  backoff: JobBackoff;
  timeoutMs: number;
  timeoutRetryable: boolean;
  payloadSchema: z.ZodType<TPayload, TPayloadInput>;
  resultSchema?: z.ZodType<TResult>;
  idempotency: JobIdempotency<TPayload>;
  handle: JobHandler<TPayload, TResult>;
  runtime: JobRuntime;
}>;

export type JobDefinitionInput<
  TPayload,
  TResult,
  TPayloadInput = TPayload,
> = Readonly<{
  name: string;
  version: number;
  payloadSchema: z.ZodType<TPayload, TPayloadInput>;
  resultSchema?: z.ZodType<TResult>;
  attempts: number;
  backoff: JobBackoff;
  timeoutMs: number;
  /**
   * Whether a timed-out attempt may be tried again.
   *
   * There is no safe default. A job that timed out because a dependency was slow
   * should come back; a job that timed out because its own work does not fit in
   * the budget will time out again and only burn the retries, so it is better
   * off failing once and being visible.
   */
  timeoutRetryable: boolean;
  idempotency: JobIdempotency<TPayload>;
  handle: JobHandler<TPayload, TResult>;
}>;

function assertBounded(
  value: number,
  minimum: number,
  maximum: number,
  what: string,
): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`The job ${what} is not acceptable.`);
  }
}

export function defineJob<TPayload, TResult, TPayloadInput = TPayload>(
  input: JobDefinitionInput<TPayload, TResult, TPayloadInput>,
): JobDefinition<TPayload, TResult, TPayloadInput> {
  if (!isValidJobName(input.name)) {
    throw new Error("The job name is not acceptable.");
  }

  if (!isValidJobVersion(input.version)) {
    throw new Error("The job version is not acceptable.");
  }

  assertBounded(input.attempts, MIN_JOB_ATTEMPTS, MAX_JOB_ATTEMPTS, "attempts");
  assertBounded(
    input.backoff.delayMs,
    MIN_JOB_BACKOFF_DELAY_MS,
    MAX_JOB_BACKOFF_DELAY_MS,
    "backoff delay",
  );
  assertBounded(
    input.timeoutMs,
    MIN_JOB_TIMEOUT_MS,
    MAX_JOB_TIMEOUT_MS,
    "timeout",
  );

  if (!JOB_BACKOFF_TYPES.includes(input.backoff.type)) {
    throw new Error("The job backoff type is not acceptable.");
  }

  if (typeof input.idempotency.key !== "function") {
    throw new Error("The job idempotency key derivation is not acceptable.");
  }

  const identity = jobIdentity(input.name, input.version);

  const runtime: JobRuntime = {
    name: input.name,
    version: input.version,
    identity,
    attempts: input.attempts,
    backoff: input.backoff,
    timeoutMs: input.timeoutMs,
    timeoutRetryable: input.timeoutRetryable,

    parsePayload: (value) => {
      // The transport limits are checked before the schema so an oversized
      // payload is reported as oversized rather than as a shape mismatch.
      if (checkJobPayload(value) !== null) {
        return { ok: false };
      }

      const result = input.payloadSchema.safeParse(value);

      return result.success
        ? { ok: true, payload: result.data }
        : { ok: false };
    },

    parseResult: (value) => {
      if (value !== undefined && !isJsonValue(value)) {
        return { ok: false };
      }

      if (!input.resultSchema) {
        return { ok: true, result: value };
      }

      const result = input.resultSchema.safeParse(value);

      return result.success ? { ok: true, result: result.data } : { ok: false };
    },

    // Both of these are reached only with a payload `parsePayload` has already
    // accepted, which is what makes the cast sound.
    idempotencyKey: (payload) => input.idempotency.key(payload as TPayload),

    run: async ({ payload, signal, context }) =>
      input.handle({ payload: payload as TPayload, signal, context }),
  };

  return {
    name: input.name,
    version: input.version,
    identity,
    attempts: input.attempts,
    backoff: input.backoff,
    timeoutMs: input.timeoutMs,
    timeoutRetryable: input.timeoutRetryable,
    payloadSchema: input.payloadSchema,
    ...(input.resultSchema === undefined
      ? {}
      : { resultSchema: input.resultSchema }),
    idempotency: input.idempotency,
    handle: input.handle,
    runtime,
  };
}
