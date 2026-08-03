import { isSpanContextValid, trace } from "@opentelemetry/api";

/**
 * The correlation fields a log line may borrow from the active span.
 *
 * They are the join between two independent systems: a trace lives in a
 * collector, a log line lives in the deployment platform's log store, and these
 * three values are what lets an operator move from one to the other without
 * guessing. They are added to a log line only when a *valid* active span exists,
 * which means they are absent whenever no SDK is registered — the default.
 *
 * What is deliberately absent is the whole propagation surface:
 *
 * - No `traceparent`. The assembled header is a wire format, and putting it in a
 *   log line would invite something downstream to parse it and trust it.
 * - No `tracestate`. It is vendor-defined and unbounded.
 * - No baggage. It is an open key/value bag and is the propagation field most
 *   likely to be carrying a user identifier.
 *
 * The values are read from the active span only. Nothing here accepts a value
 * from a client, a header, a payload, or a query string, so a caller cannot
 * choose the trace id its log line claims.
 */
export type TraceLogFields = Readonly<{
  traceId?: string;
  spanId?: string;
  /** The two-hex-digit W3C flags byte, so a sampled trace is recognizable. */
  traceFlags?: string;
}>;

const EMPTY_TRACE_LOG_FIELDS: TraceLogFields = {};

export function activeTraceLogFields(): TraceLogFields {
  try {
    const span = trace.getActiveSpan();

    if (!span) {
      return EMPTY_TRACE_LOG_FIELDS;
    }

    const spanContext = span.spanContext();

    if (!isSpanContextValid(spanContext)) {
      return EMPTY_TRACE_LOG_FIELDS;
    }

    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      traceFlags: (spanContext.traceFlags & 0xff).toString(16).padStart(2, "0"),
    };
  } catch {
    // Reading a span context must never be able to stop a line being logged.
    return EMPTY_TRACE_LOG_FIELDS;
  }
}
