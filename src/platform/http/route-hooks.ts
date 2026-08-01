import type {
  RouteContext,
  RouteFailureContext,
  RouteIdempotencyContext,
  RouteRequestContext,
  RouteSuccessContext,
} from "./route-context";
import type { RouteInputSchemas } from "./route-input";

/**
 * The five lifecycle hooks a route definition may declare.
 *
 * The set is closed. A hook cannot be added by a call site, cannot move within
 * the order, and cannot take part in the authorization decision: the factory owns
 * the order, and the two steps that run before the use case are the only ones
 * that can stop it.
 */
export const ROUTE_HOOK = {
  RATE_LIMIT: "rateLimit",
  BEFORE_EXECUTE: "beforeExecute",
  AFTER_SUCCESS: "afterSuccess",
  AFTER_FAILURE: "afterFailure",
  AUDIT: "audit",
} as const;

export type RouteHookName = (typeof ROUTE_HOOK)[keyof typeof ROUTE_HOOK];

export const ROUTE_HOOK_NAMES: readonly RouteHookName[] =
  Object.values(ROUTE_HOOK);

/**
 * The steps the factory owns rather than a definition declaring them as hooks.
 *
 * Idempotency is a lifecycle and not a hook: a reservation has to be settled
 * after the use case, and a hook list cannot express that. Cache invalidation is
 * the factory's own final post-success step. Both are named here so a failure
 * can be attributed to the right place in a log line.
 */
export const ROUTE_STEP = {
  IDEMPOTENCY: "idempotency",
  CACHE_INVALIDATION: "cacheInvalidation",
} as const;

export type RouteStepOnlyName = (typeof ROUTE_STEP)[keyof typeof ROUTE_STEP];

/** Every step name that can appear in a `route.hook_failed` line. */
export type RouteStepName = RouteHookName | RouteStepOnlyName;

export const ROUTE_STEP_NAMES: readonly RouteStepName[] = [
  ...ROUTE_HOOK_NAMES,
  ...Object.values(ROUTE_STEP),
];

export const RATE_LIMIT_OUTCOME = {
  ALLOWED: "allowed",
  REFUSED: "refused",
} as const;

export type RateLimitOutcome =
  (typeof RATE_LIMIT_OUTCOME)[keyof typeof RATE_LIMIT_OUTCOME];

/**
 * What a rate-limit hook answers.
 *
 * A decision object rather than a bare outcome, because a refusal has to be able
 * to say *when* to come back. `retryAfterMs` is the entire allowlist of response
 * metadata a hook may contribute: the factory turns it into `Retry-After`, and a
 * hook never builds a `Response`, never chooses a status, and never sets a header
 * of its own. A hook that could return headers could return any header, and the
 * response contract would stop being the factory's.
 */
export type RateLimitDecision =
  | Readonly<{ outcome: typeof RATE_LIMIT_OUTCOME.ALLOWED }>
  | Readonly<{
      outcome: typeof RATE_LIMIT_OUTCOME.REFUSED;
      retryAfterMs?: number;
    }>;

/**
 * A gate that runs before authentication and before the use case.
 *
 * It runs first on purpose: refusing an over-limit caller must not require
 * reading a session or a body. It sees request metadata and nothing about the
 * request's meaning.
 */
export type RateLimitHook = (
  context: RouteRequestContext,
) => RateLimitDecision | Promise<RateLimitDecision>;

/**
 * The settle half of an idempotency reservation.
 *
 * `begin` hands these back rather than the factory carrying an opaque handle
 * around, so the claim, the owner token, and the TTLs stay inside the closure
 * that created them. There is no shared map to clean up and nothing for the
 * factory to interpret: it either has a reservation to settle or it does not.
 */
export type IdempotencyReservation<TOutput> = Readonly<{
  complete: (output: TOutput) => void | Promise<void>;
  abort: () => void | Promise<void>;
}>;

export const IDEMPOTENCY_OUTCOME = {
  PROCEED: "proceed",
  REPLAY: "replay",
  CONFLICT: "conflict",
} as const;

export type IdempotencyOutcome =
  (typeof IDEMPOTENCY_OUTCOME)[keyof typeof IDEMPOTENCY_OUTCOME];

/**
 * What beginning an idempotent attempt answers.
 *
 * `replay` carries the previously produced output as a typed value, not a
 * `Response`: the coordinator decides *what* to answer and the factory decides
 * *how*, so a replayed answer has exactly the same envelope, status, and
 * correlation header as the original. `conflict` answers `CONFLICT`.
 *
 * `proceed` may arrive without a reservation. That is the degraded path a
 * `best-effort` policy takes when the store is unreachable: the use case runs,
 * and there is simply nothing to settle afterwards.
 */
export type IdempotencyDecision<TOutput> =
  | Readonly<{
      outcome: typeof IDEMPOTENCY_OUTCOME.PROCEED;
      reservation?: IdempotencyReservation<TOutput>;
    }>
  | Readonly<{ outcome: typeof IDEMPOTENCY_OUTCOME.REPLAY; output: TOutput }>
  | Readonly<{ outcome: typeof IDEMPOTENCY_OUTCOME.CONFLICT }>;

/**
 * Begins an idempotent attempt, after validation and authorization.
 *
 * It is placed there deliberately: a replayed answer must not be served to a
 * caller who is not allowed to have it, so the capability is required before a
 * stored result is looked up.
 *
 * There is at most one coordinator per route. Two would each claim a key and
 * neither would know about the other's reservation.
 */
export type RouteIdempotency<
  TInput extends RouteInputSchemas,
  TActor,
  TOutput,
> = (
  context: RouteIdempotencyContext<TInput, TActor>,
) => IdempotencyDecision<TOutput> | Promise<IdempotencyDecision<TOutput>>;

/**
 * A gate that runs last before the use case.
 *
 * Throwing prevents the use case from running and turns the call into a normal
 * failure response.
 */
export type BeforeExecuteHook<TInput extends RouteInputSchemas, TActor> = (
  context: RouteContext<TInput, TActor>,
) => void | Promise<void>;

/**
 * An observer that runs only after the use case succeeded.
 *
 * It is not transactional with the use case: the mutation has already committed,
 * so throwing here is recorded and the success response stands.
 */
export type AfterSuccessHook<
  TInput extends RouteInputSchemas,
  TActor,
  TOutput,
> = (
  context: RouteSuccessContext<TInput, TActor, TOutput>,
) => void | Promise<void>;

/**
 * An observer that runs after a refusal or a failure.
 *
 * It receives the normalized `PublicError` only. The raw thrown value never
 * reaches it, so an observer cannot log a provider payload or a stack trace by
 * accident.
 */
export type AfterFailureHook<TInput extends RouteInputSchemas, TActor> = (
  context: RouteFailureContext<TInput, TActor>,
) => void | Promise<void>;

/**
 * An observer that runs last, after a success.
 *
 * It is named separately from `afterSuccess` so an audit intent is visible in a
 * definition and so a failing audit is attributed to `audit` rather than hidden
 * among other post-success work. The factory writes no audit record itself: what
 * is worth auditing is a business decision, and it belongs to the definition.
 */
export type AuditHook<TInput extends RouteInputSchemas, TActor, TOutput> = (
  context: RouteSuccessContext<TInput, TActor, TOutput>,
) => void | Promise<void>;

/** Hooks run sequentially, in declaration order, within each list. */
export type RouteHooks<
  TInput extends RouteInputSchemas,
  TActor,
  TOutput,
> = Readonly<{
  rateLimit?: readonly RateLimitHook[];
  beforeExecute?: readonly BeforeExecuteHook<TInput, TActor>[];
  afterSuccess?: readonly AfterSuccessHook<TInput, TActor, TOutput>[];
  afterFailure?: readonly AfterFailureHook<TInput, TActor>[];
  audit?: readonly AuditHook<TInput, TActor, TOutput>[];
}>;
