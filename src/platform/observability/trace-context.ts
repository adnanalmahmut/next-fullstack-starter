import { z } from "zod";

/**
 * The only tracing metadata this project carries across a process boundary.
 *
 * W3C `traceparent` and `tracestate`, both validated, and nothing else.
 * Baggage is deliberately absent: it is an open key/value bag that travels with
 * a request, so it is the one propagation header most likely to be carrying a
 * user identifier or a tenant name by the time it reaches a durable row.
 *
 * These values live in the outbox and in the queue envelope, which means they are
 * written to PostgreSQL and read back by another process. That is exactly why
 * they are bounded here: an unvalidated header would be an unbounded string
 * stored forever.
 *
 * The contract lives in the observability platform rather than in the jobs
 * platform because two areas now depend on it — the tracing contract that
 * produces a carrier from the active span, and the outbox that stores one — and a
 * validator owned by the consumer would have to be imported backwards.
 */
const traceparentPattern =
  /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** The W3C maximum is 512 characters; longer values must be dropped, not truncated. */
export const MAX_TRACESTATE_LENGTH = 512;

// Printable ASCII only. A control character in a stored trace header would end
// up in a log line and in a database column.
const tracestatePattern = /^[ -~]+$/;

export function isValidTraceparent(value: unknown): value is string {
  return typeof value === "string" && traceparentPattern.test(value);
}

export function isValidTracestate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TRACESTATE_LENGTH &&
    tracestatePattern.test(value)
  );
}

export const traceContextSchema = z
  .object({
    traceparent: z.string().refine(isValidTraceparent).optional(),
    tracestate: z.string().refine(isValidTracestate).optional(),
  })
  .strict();

export type TraceContext = z.output<typeof traceContextSchema>;

/**
 * Keeps only what is valid.
 *
 * A malformed header is dropped rather than rejected: a trace is an aid, and
 * refusing to record work because a header was mangled upstream would make
 * observability a correctness dependency. `undefined` is returned when nothing
 * survives, so an empty object is never stored.
 */
export function sanitizeTraceContext(value: unknown): TraceContext | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const traceparent = isValidTraceparent(candidate.traceparent)
    ? candidate.traceparent
    : undefined;

  // `tracestate` without a `traceparent` identifies nothing, so it is dropped
  // with it rather than stored on its own.
  if (traceparent === undefined) {
    return undefined;
  }

  const tracestate = isValidTracestate(candidate.tracestate)
    ? candidate.tracestate
    : undefined;

  return tracestate === undefined
    ? { traceparent }
    : { traceparent, tracestate };
}
