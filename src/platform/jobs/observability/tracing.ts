import {
  SPAN_OUTCOME,
  withActiveSpan,
  type SpanAttributes,
} from "@/platform/observability/tracing.server";

/**
 * The job-owned half of tracing.
 *
 * The mechanics — starting a span, activating it, containing a tracer failure,
 * ending it exactly once, refusing to run a business operation twice — belong to
 * `@/platform/observability` and are shared with routes, actions, the database
 * boundaries, and storage. What stays here is what only this area can know: the
 * two span names, and the closed set of attributes a job span may carry.
 *
 * That split is deliberate. A generic tracing helper living inside the jobs
 * platform would have to be imported by every other area, which would make
 * background jobs a dependency of the request path — the one thing the jobs
 * boundary is arranged to prevent.
 *
 * Two rules still hold at this level. Tracing never fails a job: every call below
 * is guarded by the shared contract. And a span carries identity only — never a
 * payload, never a result, never an error message.
 */
export const JOB_SPAN = {
  OUTBOX_PUBLISH: "jobs.outbox.publish",
  EXECUTE: "jobs.execute",
} as const;

export type JobSpanName = (typeof JOB_SPAN)[keyof typeof JOB_SPAN];

/**
 * The attributes a job span may carry.
 *
 * The same reasoning as the log allowlist, for the same reason: span attributes
 * are shipped to a third party and kept for as long as the trace is. The job name
 * and version are safe because the registry is closed and small; the outbox id and
 * the attempt number are per-message and are attributes rather than metric
 * dimensions precisely so they cannot become one time series each.
 */
export type JobSpanAttributes = Readonly<{
  jobName?: string;
  jobVersion?: number;
  outboxId?: string;
  attempt?: number;
  batchSize?: number;
}>;

function toSpanAttributes(attributes: JobSpanAttributes): SpanAttributes {
  const result: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" || typeof value === "number") {
      result[`jobs.${key}`] = value;
    }
  }

  return result;
}

/**
 * Runs an operation inside a job span, and returns exactly what it returns.
 *
 * The span is made the active one for the duration, so anything the operation
 * calls that is itself traced — a database boundary, for instance — nests
 * underneath it rather than becoming a second root.
 */
export async function withJobSpan<T>(
  name: JobSpanName,
  attributes: JobSpanAttributes,
  run: () => Promise<T>,
): Promise<T> {
  return withActiveSpan(name, toSpanAttributes(attributes), async (span) => {
    try {
      const result = await run();

      span.setOutcome(SPAN_OUTCOME.SUCCEEDED);

      return result;
    } catch (error) {
      // The outcome and nothing else. A status message would be the error
      // message, and an error message is the most common way a payload escapes
      // into a trace.
      span.setOutcome(SPAN_OUTCOME.FAILED);

      throw error;
    }
  });
}
