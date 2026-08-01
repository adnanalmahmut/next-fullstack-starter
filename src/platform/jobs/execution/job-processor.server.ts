import "server-only";

import { UnrecoverableError, type Job } from "bullmq";

import { startOperationTimer } from "@/platform/observability/operation-timer.server";

import type { JobExecutionContext } from "../definitions/define-job";
import { jobEnvelopeSchema } from "../definitions/job-envelope";
import type { JobRegistry } from "../definitions/job-registry";
import { JOB_LOG_LEVEL, logJobEvent } from "../observability/job-logger.server";
import { JOB_OUTCOME } from "../observability/job-log-fields";
import { JOBS_LOG_EVENT } from "../observability/log-event";
import { JOB_SPAN, withJobSpan } from "../observability/tracing";

import { jobExecutionKey } from "./execution-key";
import {
  JOB_FAILURE_CODE,
  isPermanentJobFailure,
  JobTimeoutError,
  PermanentJobError,
  toJobFailureCode,
} from "./job-failure";
import { runWithJobTimeout } from "./job-timeout";

/**
 * What the worker does with one message.
 *
 * The order is fixed and it is the whole safety argument:
 *
 * 1. validate the envelope — Redis is not a trust boundary, and the row that
 *    produced this message may have been written by an older release;
 * 2. resolve the definition — an unknown name or an unsupported version is
 *    refused permanently rather than retried into the failed set twenty times;
 * 3. validate the payload against *that definition's* schema, again;
 * 4. open a span and establish the log context;
 * 5. start the timeout signal;
 * 6. run the handler, which is expected to make its own effect idempotent;
 * 7. validate the result before reporting success.
 *
 * A handler never sees a raw BullMQ job, a connection, a Prisma client, a
 * header, or a cookie. It sees a validated payload, a signal, and identifiers.
 */
export type JobProcessor = (job: Job) => Promise<unknown>;

function attemptNumber(job: Job): number {
  // BullMQ counts attempts already made; a handler wants the ordinal of the one
  // it is running.
  return (job.attemptsMade ?? 0) + 1;
}

export function createJobProcessor(registry: JobRegistry): JobProcessor {
  return async function processJob(job: Job): Promise<unknown> {
    const parsedEnvelope = jobEnvelopeSchema.safeParse(job.data);

    if (!parsedEnvelope.success) {
      throw permanent(
        JOB_FAILURE_CODE.INVALID_ENVELOPE,
        "The job envelope is not acceptable.",
      );
    }

    const envelope = parsedEnvelope.data;
    const runtime = registry.resolve(envelope.jobName, envelope.version);

    if (!runtime) {
      throw permanent(
        registry.hasName(envelope.jobName)
          ? JOB_FAILURE_CODE.UNSUPPORTED_VERSION
          : JOB_FAILURE_CODE.UNKNOWN_JOB,
        "No definition is registered for this job.",
      );
    }

    const parsedPayload = runtime.parsePayload(envelope.payload);

    if (!parsedPayload.ok) {
      throw permanent(
        JOB_FAILURE_CODE.INVALID_PAYLOAD,
        "The job payload does not match its schema.",
      );
    }

    const attempt = attemptNumber(job);
    const context: JobExecutionContext = {
      jobName: runtime.name,
      jobVersion: runtime.version,
      jobId: job.id ?? envelope.outboxId,
      outboxId: envelope.outboxId,
      attempt,
      maxAttempts: runtime.attempts,
      correlationId: envelope.correlationId,
      ...(envelope.causationId === undefined
        ? {}
        : { causationId: envelope.causationId }),
      occurredAt: envelope.occurredAt,
      executionKey: jobExecutionKey(
        runtime.name,
        runtime.version,
        runtime.idempotencyKey(parsedPayload.payload),
      ),
    };

    const fields = {
      jobName: context.jobName,
      jobVersion: context.jobVersion,
      jobId: context.jobId,
      outboxId: context.outboxId,
      queueName: job.queueName,
      attempt: context.attempt,
      maxAttempts: context.maxAttempts,
      correlationId: context.correlationId,
      ...(context.causationId === undefined
        ? {}
        : { causationId: context.causationId }),
    };

    logJobEvent(JOB_LOG_LEVEL.DEBUG, JOBS_LOG_EVENT.JOB_STARTED, fields);

    const timer = startOperationTimer();

    try {
      const result = await withJobSpan(
        JOB_SPAN.EXECUTE,
        {
          jobName: context.jobName,
          jobVersion: context.jobVersion,
          outboxId: context.outboxId,
          attempt: context.attempt,
        },
        () =>
          runWithJobTimeout(
            runtime.timeoutMs,
            runtime.timeoutRetryable,
            (signal) =>
              runtime.run({ payload: parsedPayload.payload, signal, context }),
          ),
      );

      const parsedResult = runtime.parseResult(result);

      if (!parsedResult.ok) {
        // A result that does not match its schema is a defect in the handler,
        // not a transient fault, and the effect has already happened. Failing
        // permanently keeps it visible instead of replaying the effect.
        throw permanent(
          JOB_FAILURE_CODE.INVALID_RESULT,
          "The job result does not match its schema.",
        );
      }

      logJobEvent(JOB_LOG_LEVEL.INFO, JOBS_LOG_EVENT.JOB_SUCCEEDED, {
        ...fields,
        durationMs: timer.elapsedMs(),
        outcome: JOB_OUTCOME.SUCCEEDED,
      });

      return parsedResult.result;
    } catch (error) {
      const errorCode = toJobFailureCode(error);
      const permanentFailure = isPermanentJobFailure(error);
      const willRetry = !permanentFailure && attempt < runtime.attempts;

      if (error instanceof JobTimeoutError) {
        logJobEvent(JOB_LOG_LEVEL.WARN, JOBS_LOG_EVENT.JOB_TIMED_OUT, {
          ...fields,
          durationMs: timer.elapsedMs(),
          outcome: JOB_OUTCOME.TIMED_OUT,
          errorCode,
        });
      }

      logJobEvent(
        willRetry ? JOB_LOG_LEVEL.WARN : JOB_LOG_LEVEL.ERROR,
        willRetry ? JOBS_LOG_EVENT.JOB_RETRYING : JOBS_LOG_EVENT.JOB_FAILED,
        {
          ...fields,
          durationMs: timer.elapsedMs(),
          outcome: willRetry ? JOB_OUTCOME.RETRYING : JOB_OUTCOME.FAILED,
          errorCode,
        },
      );

      if (!willRetry) {
        // The work has stopped being attempted — either because it can never
        // succeed or because the budget is spent. That is a distinct
        // operational fact from a single failed attempt, and it is the one an
        // alert should fire on, so it gets its own line. The job stays in the
        // failed set, which is where it can be inspected and redriven.
        logJobEvent(JOB_LOG_LEVEL.ERROR, JOBS_LOG_EVENT.JOB_DEAD_LETTERED, {
          ...fields,
          outcome: JOB_OUTCOME.DEAD_LETTERED,
          errorCode,
        });
      }

      // `UnrecoverableError` is how BullMQ is told to stop retrying. Only the
      // stable code goes into its message; the original error is not attached,
      // because BullMQ serializes a failed job's message into Redis and a raw
      // message is the usual way a payload ends up there.
      throw permanentFailure
        ? new UnrecoverableError(`Job failed permanently: ${errorCode}`)
        : error;
    }
  };
}

function permanent(
  code: (typeof JOB_FAILURE_CODE)[keyof typeof JOB_FAILURE_CODE],
  message: string,
): PermanentJobError {
  return new PermanentJobError(code, message);
}
