import type { ErrorCode } from "@/shared/errors/error-code";

/**
 * The complete allowlist of fields a cache or concurrency log line may carry.
 *
 * These two areas see the values most worth never printing: a Redis key derived
 * from a user identifier, a cached payload, an idempotency key, a fingerprint, a
 * lock token, a caller's address. The field set is therefore closed and shared,
 * so widening it is one reviewed change rather than a decision each call site
 * makes for itself.
 *
 * A line may carry a name, a duration, a reason, and a bounded number. It may
 * never carry a key, a value, an input, an output, a token, an identifier the
 * caller supplied, a connection string, a raw error, or a stack trace.
 */
export const CONTROL_MODULE = {
  CACHE: "cache",
  CONCURRENCY: "concurrency",
} as const;

export type ControlModule =
  (typeof CONTROL_MODULE)[keyof typeof CONTROL_MODULE];

/**
 * Why a control behaved the way its event name says it did.
 *
 * The values are reasons, never restatements of the event: `cache.bypassed` is
 * worth a line either way, but `disabled` and `unavailable` are two very
 * different operational facts and only this field separates them.
 */
export const CONTROL_OUTCOME = {
  DISABLED: "disabled",
  UNAVAILABLE: "unavailable",
  DEGRADED: "degraded",
  EXPIRED: "expired",
  CORRUPT: "corrupt",
  OVERSIZED: "oversized",
} as const;

export type ControlOutcome =
  (typeof CONTROL_OUTCOME)[keyof typeof CONTROL_OUTCOME];

export type ControlLogFields = Readonly<{
  module: ControlModule;
  operation: string;
  routeName?: string;
  requestId?: string;
  durationMs?: number;
  outcome?: ControlOutcome;
  errorCode?: ErrorCode;
  retryAfterMs?: number;
  ttlMs?: number;
}>;

export type ControlLogInput = Readonly<{
  module: ControlModule;
  operation: string;
  routeName?: string | undefined;
  requestId?: string | undefined;
  durationMs?: number | undefined;
  outcome?: ControlOutcome | undefined;
  errorCode?: ErrorCode | undefined;
  retryAfterMs?: number | undefined;
  ttlMs?: number | undefined;
}>;

/**
 * Builds the payload for a control event.
 *
 * Absent values are omitted rather than serialized as `null`, so a line never
 * claims to know something it does not, and anything the input carries beyond
 * the allowlist is dropped here rather than at each call site.
 */
export function toControlLogFields(input: ControlLogInput): ControlLogFields {
  return {
    module: input.module,
    operation: input.operation,
    ...(input.routeName === undefined ? {} : { routeName: input.routeName }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: input.retryAfterMs }),
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  };
}
