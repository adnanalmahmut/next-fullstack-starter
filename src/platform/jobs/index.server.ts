import "server-only";

/**
 * The controlled server-only entry point for background jobs.
 *
 * Everything outside this directory — the worker entry point included — imports
 * from here and never from a file inside it. BullMQ and `ioredis` stay behind
 * this boundary, enforced by an ESLint rule and a contract test, so removing
 * background jobs from a generated project is a matter of deleting a directory
 * rather than hunting for imports.
 *
 * Importing this module opens no connection, reads no environment variable, and
 * starts no polling loop.
 *
 * ## What is deliberately not exported
 *
 * `getJobQueue`, `requireJobQueue`, and `queue.add` are absent. Business code
 * enqueues work by writing an outbox row inside the transaction that earns it;
 * if it could reach the queue directly it would eventually publish next to a
 * transaction rather than inside one, and a rollback would leave a job running
 * against a change that never happened. That is the failure the outbox exists to
 * remove, so the shortcut is not offered. The dispatcher — inside this
 * directory — is the only publisher.
 */

export {
  getJobsConfiguration,
  getJobsRedisConfiguration,
  isJobQueueConfigured,
  isJobsEnabled,
  resetJobsConfiguration,
  type JobsConfiguration,
  type JobsRedisConfiguration,
  type OutboxConfiguration,
} from "./config/jobs-config";

export {
  defineJob,
  JOB_BACKOFF_TYPE,
  JOB_BACKOFF_TYPES,
  MAX_JOB_ATTEMPTS,
  MAX_JOB_BACKOFF_DELAY_MS,
  MAX_JOB_TIMEOUT_MS,
  MIN_JOB_ATTEMPTS,
  MIN_JOB_BACKOFF_DELAY_MS,
  MIN_JOB_TIMEOUT_MS,
  type JobBackoff,
  type JobBackoffType,
  type JobDefinition,
  type JobDefinitionInput,
  type JobExecutionContext,
  type JobHandler,
  type JobHandlerArguments,
  type JobIdempotency,
  type JobRuntime,
} from "./definitions/define-job";

export {
  checkJobPayload,
  isJsonValue,
  isValidJobIdentifier,
  jobEnvelopeSchema,
  jobPayloadByteLength,
  MAX_JOB_PAYLOAD_BYTES,
  PAYLOAD_REJECTION,
  type JobEnvelope,
  type PayloadRejection,
} from "./definitions/job-envelope";

export {
  isValidJobName,
  isValidJobVersion,
  jobIdentity,
  MAX_JOB_NAME_LENGTH,
  MAX_JOB_VERSION,
  MIN_JOB_VERSION,
  parseJobIdentity,
} from "./definitions/job-identity";

export {
  createJobRegistry,
  type JobRegistry,
  type JobRegistryEntry,
} from "./definitions/job-registry";

export { JOB_REGISTRY } from "./definitions/registry";

export { jobExecutionKey } from "./execution/execution-key";

export {
  isPermanentJobFailure,
  JOB_FAILURE_CODE,
  JOB_FAILURE_CODES,
  JobTimeoutError,
  PermanentJobError,
  toJobFailureCode,
  type JobFailureCode,
} from "./execution/job-failure";

export { runWithJobTimeout } from "./execution/job-timeout";

export {
  runDatabaseJobOnce,
  type DatabaseJobExecution,
  type DatabaseJobOutcome,
} from "./execution/run-database-job-once.server";

export {
  JOB_LOG_FIELD_NAMES,
  JOB_OUTCOME,
  toJobLogFields,
  type JobLogFields,
  type JobLogInput,
  type JobOutcome,
} from "./observability/job-log-fields";

export {
  JOBS_LOG_EVENT,
  JOBS_LOG_EVENTS,
  type JobsLogEvent,
} from "./observability/log-event";

export {
  isValidTraceparent,
  isValidTracestate,
  MAX_TRACESTATE_LENGTH,
  sanitizeTraceContext,
  traceContextSchema,
  type TraceContext,
} from "./observability/trace-context";

export {
  currentTraceContext,
  JOB_SPAN,
  withJobSpan,
  type JobSpanName,
} from "./observability/tracing";

export {
  MAX_OUTBOX_BACKOFF_MS,
  OUTBOX_DEAD_LETTER_CODE,
  OUTBOX_DEAD_LETTER_CODES,
  OUTBOX_ERROR_CODE,
  outboxBackoffDelayMs,
  type OutboxDeadLetterReason,
  type OutboxErrorCode,
} from "./outbox/outbox-message";

export {
  writeOutboxMessage,
  type OutboxWriteResult,
  type WriteOutboxMessageInput,
} from "./outbox/write-outbox-message.server";

export {
  createOutboxDispatcher,
  type OutboxDispatcher,
  type OutboxDispatcherOptions,
  type OutboxDispatchSummary,
} from "./outbox/outbox-dispatcher.server";

/**
 * Teardown only. It closes the queue and the connection it owns; it cannot be
 * used to reach the queue, which is why it is the one queue function exported.
 */
export { closeJobQueue, JOBS_QUEUE_NAME } from "./queue/job-queue.server";

export {
  startJobsWorkerRuntime,
  type JobsWorkerRuntime,
  type StartJobsWorkerOptions,
} from "./runtime/worker-runtime.server";
