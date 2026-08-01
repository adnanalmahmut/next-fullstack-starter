/**
 * What a caller wants to happen when Redis is not there.
 *
 * There is no default. Every use of a rate limiter, an idempotency scope, or a
 * lock names its policy at the call site, because the right answer is a property
 * of the operation and nothing else can know it: refusing a payment because a
 * lock was unreachable is correct, and refusing a search because a rate limiter
 * was unreachable is an outage the limiter caused.
 *
 * Making it explicit also means the question is asked. An implicit fallback is a
 * decision nobody remembers making, discovered during the incident it caused.
 */
export const AVAILABILITY_POLICY = {
  /**
   * The operation cannot run without the control.
   *
   * A disabled or unreachable Redis refuses the request with
   * `DEPENDENCY_UNAVAILABLE` and a 503. The use case does not run, so nothing is
   * written and the caller may retry the identical request.
   */
  REQUIRED: "required",
  /**
   * The operation runs without the control.
   *
   * The degradation is logged. This is never acceptable for a financial
   * operation or for anything else that cannot tolerate being performed twice.
   */
  BEST_EFFORT: "best-effort",
} as const;

export type AvailabilityPolicy =
  (typeof AVAILABILITY_POLICY)[keyof typeof AVAILABILITY_POLICY];

export const AVAILABILITY_POLICIES: readonly AvailabilityPolicy[] =
  Object.values(AVAILABILITY_POLICY);

/**
 * What a rate limiter does when it cannot count.
 *
 * Rate limiting gets its own vocabulary because `best-effort` and `required`
 * would read as the wrong question here. A limiter is asked to *decide*, and
 * with no counter the two honest decisions are "let everything through" and
 * "let nothing through": availability or protection. A public endpoint usually
 * wants `allow`; an endpoint the limiter exists to shield — a sign-in attempt, a
 * one-time-code request — usually wants `deny`.
 */
export const RATE_LIMIT_FALLBACK = {
  ALLOW: "allow",
  DENY: "deny",
} as const;

export type RateLimitFallback =
  (typeof RATE_LIMIT_FALLBACK)[keyof typeof RATE_LIMIT_FALLBACK];

export const RATE_LIMIT_FALLBACKS: readonly RateLimitFallback[] =
  Object.values(RATE_LIMIT_FALLBACK);
