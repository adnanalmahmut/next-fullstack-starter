import { z } from "zod";

import { traceContextSchema } from "../observability/trace-context";

import { isValidJobName, isValidJobVersion } from "./job-identity";

/**
 * The wire format of a queued job.
 *
 * Everything a worker needs to decide what a message is, and nothing a worker
 * has any business seeing. There is no request, no session, no header, no
 * cookie, and no actor object here — only the identity of the work, a payload
 * the definition will validate for itself, and the identifiers that let a log
 * line be tied back to the request that caused it.
 *
 * The envelope is validated twice: once when the outbox row is written, so a
 * malformed message never reaches durable storage, and once again inside the
 * worker, because the row may have been written by an older release and Redis
 * is not a trust boundary.
 */
export const MAX_JOB_PAYLOAD_BYTES = 64 * 1024;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_IDENTIFIER_LENGTH = 128;

export function isValidJobIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    identifierPattern.test(value)
  );
}

const jobIdentifierSchema = z.string().refine(isValidJobIdentifier);

export const jobEnvelopeSchema = z
  .object({
    jobName: z.string().refine(isValidJobName),
    version: z.number().refine(isValidJobVersion),
    payload: z.unknown(),
    outboxId: jobIdentifierSchema,
    correlationId: jobIdentifierSchema,
    causationId: jobIdentifierSchema.optional(),
    occurredAt: z.iso.datetime(),
    traceContext: traceContextSchema.optional(),
  })
  .strict();

export type JobEnvelope<TPayload> = Readonly<{
  jobName: string;
  version: number;
  payload: TPayload;
  outboxId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  traceContext?: Readonly<{
    traceparent?: string;
    tracestate?: string;
  }>;
}>;

/**
 * Whether a value is representable as JSON without losing or inventing meaning.
 *
 * A payload crosses a process boundary through `JSON.stringify`, so anything
 * that does not survive that round trip is refused at the point of writing
 * rather than silently changed. A `Date` becomes a string, a `Map` becomes
 * `{}`, a `Buffer` becomes a shape nobody expects, `undefined` disappears from
 * an object and becomes `null` in an array, and a class instance arrives as a
 * plain object with its methods gone. Each of those is a bug that surfaces days
 * later inside a worker; none of them is worth the convenience.
 */
export function isJsonValue(value: unknown): boolean {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case "string":
    case "boolean": {
      return true;
    }
    case "number": {
      return Number.isFinite(value);
    }
    case "object": {
      break;
    }
    default: {
      return false;
    }
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  const prototype = Object.getPrototypeOf(value) as unknown;

  // Only a plain object. A class instance, a `Map`, a `Date`, and a `Buffer`
  // all fail here, which is the point.
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every((entry) =>
    isJsonValue(entry),
  );
}

/** The serialized size of a payload, measured the way Redis will store it. */
export function jobPayloadByteLength(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");
}

export const PAYLOAD_REJECTION = {
  NOT_JSON: "not-json",
  TOO_LARGE: "too-large",
} as const;

export type PayloadRejection =
  (typeof PAYLOAD_REJECTION)[keyof typeof PAYLOAD_REJECTION];

/**
 * Checks a payload against the transport's two hard limits.
 *
 * Returns the reason rather than throwing, because both callers — the writer
 * and the dispatcher — have to turn a rejection into their own outcome: a
 * refused write in one case, a dead-lettered row in the other.
 */
export function checkJobPayload(payload: unknown): PayloadRejection | null {
  if (payload === undefined || !isJsonValue(payload)) {
    return PAYLOAD_REJECTION.NOT_JSON;
  }

  return jobPayloadByteLength(payload) > MAX_JOB_PAYLOAD_BYTES
    ? PAYLOAD_REJECTION.TOO_LARGE
    : null;
}
