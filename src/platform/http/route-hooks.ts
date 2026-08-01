import type {
  RouteContext,
  RouteFailureContext,
  RouteIdempotencyContext,
  RouteRequestContext,
  RouteSuccessContext,
} from "./route-context";
import type { RouteInputSchemas } from "./route-input";

/**
 * The six lifecycle hooks a route definition may declare.
 *
 * The set is closed. A hook cannot be added by a call site, cannot move within
 * the order, and cannot take part in the authorization decision: the factory owns
 * the order, and the two hooks that run before the use case are the only ones
 * that can stop it.
 */
export const ROUTE_HOOK = {
  RATE_LIMIT: "rateLimit",
  IDEMPOTENCY: "idempotency",
  BEFORE_EXECUTE: "beforeExecute",
  AFTER_SUCCESS: "afterSuccess",
  AFTER_FAILURE: "afterFailure",
  AUDIT: "audit",
} as const;

export type RouteHookName = (typeof ROUTE_HOOK)[keyof typeof ROUTE_HOOK];

export const ROUTE_HOOK_NAMES: readonly RouteHookName[] =
  Object.values(ROUTE_HOOK);

/**
 * What a rate-limit hook answers.
 *
 * A decision rather than an exception, so the factory owns the refusal and every
 * limiter answers the same status and the same stable code. No limiter is
 * implemented in this change: the extension point exists, and a definition that
 * declares no hook is never limited.
 */
export const RATE_LIMIT_OUTCOME = {
  ALLOWED: "allowed",
  REFUSED: "refused",
} as const;

export type RateLimitOutcome =
  (typeof RATE_LIMIT_OUTCOME)[keyof typeof RATE_LIMIT_OUTCOME];

/**
 * A gate that runs before authentication and before the use case.
 *
 * It runs first on purpose: refusing an over-limit caller must not require
 * reading a session or a body. It sees request metadata and nothing about the
 * request's meaning.
 */
export type RateLimitHook = (
  context: RouteRequestContext,
) => RateLimitOutcome | Promise<RateLimitOutcome>;

/**
 * What an idempotency hook answers.
 *
 * `replay` carries the previously produced output as a typed value, not a
 * `Response`: the hook decides *what* to answer and the factory decides *how*, so
 * a replayed answer has exactly the same envelope, status, and correlation header
 * as the original. `conflict` is the same key seen again while the first attempt
 * is still unresolved, and answers `CONFLICT`.
 */
export const IDEMPOTENCY_OUTCOME = {
  PROCEED: "proceed",
  REPLAY: "replay",
  CONFLICT: "conflict",
} as const;

export type IdempotencyDecision<TOutput> =
  | Readonly<{ outcome: typeof IDEMPOTENCY_OUTCOME.PROCEED }>
  | Readonly<{ outcome: typeof IDEMPOTENCY_OUTCOME.REPLAY; output: TOutput }>
  | Readonly<{ outcome: typeof IDEMPOTENCY_OUTCOME.CONFLICT }>;

/**
 * A gate that runs after validation and authorization and before the use case.
 *
 * It is placed there deliberately: a replayed answer must not be served to a
 * caller who is not allowed to have it, so the capability is required before a
 * stored result is looked up. No store is implemented in this change.
 */
export type IdempotencyHook<
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
 * It is where a definition records an idempotency result. It is not transactional
 * with the use case: the mutation has already committed, so throwing here is
 * recorded and the success response stands.
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
  idempotency?: readonly IdempotencyHook<TInput, TActor, TOutput>[];
  beforeExecute?: readonly BeforeExecuteHook<TInput, TActor>[];
  afterSuccess?: readonly AfterSuccessHook<TInput, TActor, TOutput>[];
  afterFailure?: readonly AfterFailureHook<TInput, TActor>[];
  audit?: readonly AuditHook<TInput, TActor, TOutput>[];
}>;
