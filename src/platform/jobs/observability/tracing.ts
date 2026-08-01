import {
  context as otelContext,
  isSpanContextValid,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

import { sanitizeTraceContext, type TraceContext } from "./trace-context";

/**
 * Tracing for background jobs, through the OpenTelemetry API and nothing else.
 *
 * The API package is a facade: with no SDK registered every call here is a
 * no-op, which is exactly the property that lets this project depend on it
 * without deciding for a downstream project which vendor, exporter, or sampler
 * it runs. No SDK and no exporter is installed, and adding one is a deployment
 * choice made outside this repository.
 *
 * Two rules hold throughout. Tracing never fails a job: every call is guarded,
 * because a job that fails because its span could not be created would be worse
 * than a job with no span. And a span carries identity only — never a payload,
 * never a result, never an error message.
 */
export const JOB_SPAN = {
  OUTBOX_PUBLISH: "jobs.outbox.publish",
  EXECUTE: "jobs.execute",
} as const;

export type JobSpanName = (typeof JOB_SPAN)[keyof typeof JOB_SPAN];

const TRACER_NAME = "next-fullstack-starter/jobs";

/**
 * The attributes a job span may carry.
 *
 * The same reasoning as the log allowlist, for the same reason: span attributes
 * are shipped to a third party and kept for as long as the trace is.
 */
export type JobSpanAttributes = Readonly<{
  jobName?: string;
  jobVersion?: number;
  outboxId?: string;
  attempt?: number;
  batchSize?: number;
}>;

function toSpanAttributes(
  attributes: JobSpanAttributes,
): Record<string, string | number> {
  const result: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" || typeof value === "number") {
      result[`jobs.${key}`] = value;
    }
  }

  return result;
}

function startSpan(
  name: JobSpanName,
  attributes: JobSpanAttributes,
): Span | null {
  try {
    return trace
      .getTracer(TRACER_NAME)
      .startSpan(name, { attributes: toSpanAttributes(attributes) });
  } catch {
    return null;
  }
}

function endSpan(span: Span, failed: boolean): void {
  try {
    if (failed) {
      // The code only. A status message would be the error message, and an
      // error message is the most common way a payload escapes into a trace.
      span.setStatus({ code: SpanStatusCode.ERROR });
    }

    span.end();
  } catch {
    // A tracing failure is not a job failure.
  }
}

/**
 * Runs an operation inside a span, and returns exactly what it returns.
 *
 * The span is made the active one for the duration, so anything the operation
 * calls that is itself instrumented nests underneath it rather than becoming a
 * second root.
 */
export async function withJobSpan<T>(
  name: JobSpanName,
  attributes: JobSpanAttributes,
  run: () => Promise<T>,
): Promise<T> {
  const span = startSpan(name, attributes);

  if (!span) {
    return run();
  }

  // Whether the operation itself was entered. It is what tells a broken
  // context implementation apart from a failing operation: the first is
  // recovered from by running without a span, the second must propagate.
  let entered = false;

  const invoke = async (): Promise<T> => {
    entered = true;

    return run();
  };

  try {
    let result: T;

    try {
      result = await otelContext.with(
        trace.setSpan(otelContext.active(), span),
        invoke,
      );
    } catch (error) {
      if (entered) {
        throw error;
      }

      result = await run();
    }

    endSpan(span, false);

    return result;
  } catch (error) {
    endSpan(span, true);

    throw error;
  }
}

/**
 * The W3C trace context of the caller, when there is one.
 *
 * This is how a trace survives the boundary between the request that recorded
 * the work and the worker that runs it minutes later: the request's identity is
 * written into the outbox row as two validated strings, and the worker reads
 * them back. Without an SDK there is no active span and this answers
 * `undefined`, which is a correct answer and not a failure.
 */
export function currentTraceContext(): TraceContext | undefined {
  try {
    const span = trace.getActiveSpan();

    if (!span) {
      return undefined;
    }

    const spanContext = span.spanContext();

    if (!isSpanContextValid(spanContext)) {
      return undefined;
    }

    const flags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, "0");

    return sanitizeTraceContext({
      traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`,
      tracestate: spanContext.traceState?.serialize(),
    });
  } catch {
    return undefined;
  }
}
