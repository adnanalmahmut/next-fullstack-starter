import "server-only";

import {
  context as otelContext,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";

import { sanitizeTraceContext, type TraceContext } from "./trace-context";

/**
 * The one tracing contract in this application, expressed through
 * `@opentelemetry/api` and nothing else.
 *
 * The API package is a facade. With no SDK registered every call below is a
 * no-op — no span is created, no context is switched, nothing is exported — and
 * that is what lets every call site depend on this file unconditionally. A route,
 * an action, a job, a repository, and a storage adapter all trace the same way
 * whether or not a collector exists, and none of them imports an SDK, an
 * exporter, or a sampler. Registering providers is the lifecycle module's job and
 * happens exactly once per process.
 *
 * Four rules hold everywhere in this file, and they are the reason to read it
 * carefully rather than skim it:
 *
 * - **Tracing never changes an outcome.** Every OpenTelemetry call is guarded.
 *   A tracer that throws, a context manager that throws, a `setAttribute` that
 *   throws, an `end` that throws — none of them may turn a successful request
 *   into a failed one, and none of them may turn a failure into a different
 *   failure.
 * - **The operation runs exactly once.** That is the subtle half of the rule
 *   above. Recovering from a broken context implementation by "just running it
 *   again" would re-execute a mutation, so the recovery is only ever taken when
 *   the operation provably has not started.
 * - **A business error always propagates.** A span records that something failed;
 *   it never swallows it and never replaces it.
 * - **A span carries identity, never content.** No payload, no result, no input,
 *   no output, no header, no cookie, no actor, no message. `recordException` is
 *   deliberately never called: it copies `error.message` and `error.stack` into
 *   the span, which is the single most reliable way for a payload to reach a
 *   third party.
 */
const TRACER_NAME = "next-fullstack-starter";

/**
 * The value types a span attribute may hold.
 *
 * Deliberately not `AttributeValue`: arrays and `undefined` are excluded so an
 * attribute can never become a serialized collection, which is how a payload
 * arrives somewhere it was not supposed to.
 */
export type SpanAttributeValue = string | number | boolean;

export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;

/**
 * How an operation ended, as a span attribute and as a span status.
 *
 * `replayed` exists because an idempotent retry is neither a fresh success nor a
 * failure, and collapsing it into `succeeded` would make a duplicate-submission
 * rate impossible to see.
 */
export const SPAN_OUTCOME = {
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  REPLAYED: "replayed",
} as const;

export type SpanOutcome = (typeof SPAN_OUTCOME)[keyof typeof SPAN_OUTCOME];

/** The attribute names this application sets on its own spans. */
export const SPAN_ATTRIBUTE = {
  OUTCOME: "app.outcome",
  ERROR_CODE: "app.error.code",
} as const;

/**
 * What a traced operation may do to its own span.
 *
 * It is a narrow recorder rather than the `Span` itself, and that is the point:
 * a call site cannot reach `recordException`, cannot add an event, cannot create
 * a link, and cannot set a status message. Every method is a no-op when there is
 * no span, so a caller never branches on whether tracing is on.
 */
export type SpanRecorder = Readonly<{
  setAttributes: (attributes: SpanAttributes) => void;
  /** Sets `app.outcome`, the span status, and — when given — `app.error.code`. */
  setOutcome: (outcome: SpanOutcome, errorCode?: string) => void;
}>;

const NOOP_SPAN_RECORDER: SpanRecorder = {
  setAttributes: () => undefined,
  setOutcome: () => undefined,
};

function startSpan(name: string, attributes: SpanAttributes): Span | null {
  try {
    return trace.getTracer(TRACER_NAME).startSpan(name, { attributes });
  } catch {
    return null;
  }
}

function createRecorder(span: Span): SpanRecorder {
  return {
    setAttributes: (attributes) => {
      try {
        span.setAttributes(attributes);
      } catch {
        // A tracing failure is not an operation failure.
      }
    },
    setOutcome: (outcome, errorCode) => {
      try {
        span.setAttribute(SPAN_ATTRIBUTE.OUTCOME, outcome);

        if (errorCode !== undefined) {
          span.setAttribute(SPAN_ATTRIBUTE.ERROR_CODE, errorCode);
        }

        // The code only, never a message. A status message is the error message,
        // and an error message is the most common way a payload escapes into a
        // trace.
        span.setStatus({
          code:
            outcome === SPAN_OUTCOME.FAILED
              ? SpanStatusCode.ERROR
              : SpanStatusCode.OK,
        });
      } catch {
        // A tracing failure is not an operation failure.
      }
    },
  };
}

function endSpan(span: Span): void {
  try {
    span.end();
  } catch {
    // A span that cannot be ended is a lost span, not a lost operation.
  }
}

/**
 * Runs an operation inside an active span and returns exactly what it returns.
 *
 * The span is made the *active* one for the duration, so anything the operation
 * calls that is itself traced nests underneath it rather than becoming a second
 * root. That is what makes a request, the outbox row it writes, and the job that
 * row produces one trace rather than three.
 *
 * The `entered` flag is the whole of the correctness argument for the recovery
 * path. `context.with` can fail for two very different reasons: the context
 * implementation is broken, or the operation itself threw. The first is
 * recoverable — run the operation without a span — and the second must not be
 * "recovered" from, because the operation already ran and running it again would
 * repeat its effect. The flag is set as the first statement inside the operation,
 * so it distinguishes the two cases exactly.
 */
export async function withActiveSpan<T>(
  name: string,
  attributes: SpanAttributes,
  run: (span: SpanRecorder) => Promise<T>,
): Promise<T> {
  const span = startSpan(name, attributes);

  if (!span) {
    return run(NOOP_SPAN_RECORDER);
  }

  const recorder = createRecorder(span);
  let entered = false;

  const invoke = async (): Promise<T> => {
    entered = true;

    return run(recorder);
  };

  try {
    try {
      return await otelContext.with(
        trace.setSpan(otelContext.active(), span),
        invoke,
      );
    } catch (error) {
      if (entered) {
        throw error;
      }

      return await run(NOOP_SPAN_RECORDER);
    }
  } finally {
    // In `finally`, so a span is ended on every path: success, business failure,
    // and a failure of the context machinery itself.
    endSpan(span);
  }
}

/**
 * The W3C trace context of the active span, when there is one.
 *
 * This is how a trace survives a boundary the process cannot follow: the caller's
 * identity is written into an outbox row as two validated strings, or onto a queue
 * envelope, and the other side reads it back. The carrier is produced by the
 * registered propagator rather than formatted by hand, so the format is the
 * propagator's business and not this application's.
 *
 * With no SDK there is no global propagator and no active span, and the answer is
 * `undefined`. That is a correct answer, not a failure: work is still recorded
 * and still runs, simply without a parent.
 */
export function currentTraceContext(): TraceContext | undefined {
  try {
    const span = trace.getActiveSpan();

    if (!span || !isSpanContextValid(span.spanContext())) {
      return undefined;
    }

    const carrier: Record<string, unknown> = {};

    propagation.inject(otelContext.active(), carrier);

    return sanitizeTraceContext(carrier);
  } catch {
    return undefined;
  }
}

/**
 * Runs an operation with a remote parent restored from stored trace context.
 *
 * The carrier is handed to the registered propagator's `extract`, which is the
 * official way to turn `traceparent` and `tracestate` back into a context — and
 * the reason nothing here parses a header by hand.
 *
 * Malformed context is dropped rather than rejected, and the operation runs as a
 * root. A job that refused to execute because a header was mangled by an older
 * release would make observability a correctness dependency, which is exactly
 * backwards.
 *
 * Baggage is never extracted. The carrier is built from the two validated fields
 * and nothing else, so a `baggage` entry that somehow reached durable storage
 * cannot be revived here.
 */
export async function runWithRemoteTraceContext<T>(
  traceContext: TraceContext | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const sanitized = sanitizeTraceContext(traceContext);
  const traceparent = sanitized?.traceparent;

  if (traceparent === undefined) {
    return run();
  }

  let entered = false;

  const invoke = async (): Promise<T> => {
    entered = true;

    return run();
  };

  try {
    const carrier: Record<string, string> = {
      traceparent,
      ...(sanitized?.tracestate === undefined
        ? {}
        : { tracestate: sanitized.tracestate }),
    };

    return await otelContext.with(
      propagation.extract(ROOT_CONTEXT, carrier),
      invoke,
    );
  } catch (error) {
    if (entered) {
      throw error;
    }

    return run();
  }
}

/**
 * Sets the outcome on whatever span is currently active, safely.
 *
 * For the few places that learn how an operation ended outside the scope that
 * created the span — a post-outcome observer, for instance. It is a no-op when no
 * span is active.
 */
export function setSpanOutcomeSafely(
  outcome: SpanOutcome,
  errorCode?: string,
): void {
  try {
    const span = trace.getActiveSpan();

    if (!span) {
      return;
    }

    createRecorder(span).setOutcome(outcome, errorCode);
  } catch {
    // A tracing failure is not an operation failure.
  }
}
