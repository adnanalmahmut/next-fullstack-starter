import "server-only";

import type * as z from "zod";

import type {
  IdempotencyDecision,
  RateLimitDecision,
  RouteIdempotency,
  RouteRequestContext,
} from "@/platform/http/index.server";
import {
  IDEMPOTENCY_OUTCOME,
  RATE_LIMIT_OUTCOME,
} from "@/platform/http/index.server";
import type { RouteInputSchemas } from "@/platform/http/route-input";
import {
  DependencyUnavailableError,
  ValidationError,
} from "@/shared/errors/application-error";

import {
  AVAILABILITY_POLICY,
  RATE_LIMIT_FALLBACK,
  type AvailabilityPolicy,
  type RateLimitFallback,
} from "./availability-policy";
import {
  abortIdempotency,
  beginIdempotency,
  completeIdempotency,
  idempotencyFingerprint,
  IDEMPOTENCY_BEGIN_STATUS,
  IDEMPOTENCY_KEY_HEADER,
  isValidIdempotencyKey,
  type IdempotencyScope,
} from "./idempotency.server";
import {
  consumeRateLimit,
  RATE_LIMIT_STATUS,
  type RateLimitIdentity,
} from "./rate-limit.server";

/**
 * The bridge between the concurrency controls and the Route Handler factory.
 *
 * The controls answer questions — is this caller over its limit, has this
 * request already been performed — and the factory owns what happens next. This
 * file is the only place the two meet, and it is where a policy turns a control's
 * answer into a route's behaviour.
 *
 * Nothing here builds a `Response`, chooses a status, or reaches a use case. A
 * Redis client never leaves this directory, so a use case cannot be handed one
 * even by accident.
 *
 * No existing endpoint is wired to any of this. These are adapters a future
 * definition opts into; the behaviour is proved by the factory's own tests and by
 * fixtures rather than by making an administration route depend on Redis.
 */

/** Where the limiter's subject comes from. */
export type RateLimitSubject = (context: RouteRequestContext) => string;

export type RateLimitAdapterOptions = Readonly<{
  /** The limiter's stable name. Defaults to the route's own name. */
  name?: string;
  limit: number;
  windowMs: number;
  cost?: number;
  /**
   * How the subject is derived from the request.
   *
   * Supplied by the route, because only the route knows what it is limiting:
   * an address for an anonymous endpoint, an actor for an authenticated one, an
   * API key for a machine caller. The value is hashed before it becomes a key
   * and is never logged.
   */
  subject: RateLimitSubject;
  /**
   * What to do when the limiter cannot count.
   *
   * Required, with no default. `allow` keeps the endpoint available and drops
   * the protection; `deny` keeps the protection and drops the availability. Both
   * are defensible and only the endpoint knows which it wants.
   */
  fallback: RateLimitFallback;
}>;

/**
 * Builds a rate-limit hook for a route definition.
 *
 * The hook answers a decision, and the factory turns a refusal into
 * `RATE_LIMITED` with a `Retry-After` header. A `deny` fallback throws
 * `DEPENDENCY_UNAVAILABLE` instead, because "we could not check" is not the same
 * answer as "you are over your limit" and a client should not be told to slow
 * down when the truth is that a dependency is down.
 */
export function rateLimitHook(options: RateLimitAdapterOptions) {
  return async function checkRateLimit(
    context: RouteRequestContext,
  ): Promise<RateLimitDecision> {
    const identity: RateLimitIdentity = {
      name: options.name ?? context.routeName,
      subject: options.subject(context),
    };

    const result = await consumeRateLimit({
      identity,
      limit: options.limit,
      windowMs: options.windowMs,
      ...(options.cost === undefined ? {} : { cost: options.cost }),
    });

    if (result.status === RATE_LIMIT_STATUS.LIMITED) {
      return {
        outcome: RATE_LIMIT_OUTCOME.REFUSED,
        retryAfterMs: result.retryAfterMs,
      };
    }

    if (result.status === RATE_LIMIT_STATUS.ALLOWED) {
      return { outcome: RATE_LIMIT_OUTCOME.ALLOWED };
    }

    if (options.fallback === RATE_LIMIT_FALLBACK.DENY) {
      throw new DependencyUnavailableError("The rate limiter is unavailable.");
    }

    return { outcome: RATE_LIMIT_OUTCOME.ALLOWED };
  };
}

/**
 * Reads the `Idempotency-Key` header.
 *
 * The header is read here and nowhere else: it is transport, and a use case that
 * could read it would be a use case that could decide its own idempotency. The
 * raw value never leaves this module — it is hashed into the key and dropped.
 */
export function readIdempotencyKey(headers: Headers): string | null {
  const value = headers.get(IDEMPOTENCY_KEY_HEADER);

  return isValidIdempotencyKey(value) ? value : null;
}

export type IdempotencyAdapterOptions<TOutput> = Readonly<{
  /** The API version the stored result belongs to, such as `v1`. */
  apiVersion: string;
  /**
   * Validates a stored result before it is replayed.
   *
   * A stored value that no longer satisfies the route's contract is treated as a
   * conflict rather than replayed, so a shape change cannot hand a client a
   * value this deploy promises it will never return.
   */
  outputSchema: z.ZodType<TOutput>;
  /**
   * What to do when the store is disabled or unreachable.
   *
   * `required` refuses with `DEPENDENCY_UNAVAILABLE` and the use case does not
   * run. `best-effort` runs the use case with no idempotency at all — which
   * means a retry performs the operation again, and which is therefore never
   * acceptable for a financial or otherwise non-repeatable operation.
   */
  policy: AvailabilityPolicy;
  /**
   * Whether the header is mandatory.
   *
   * When it is and the caller omitted it, the request is refused as invalid
   * input: the caller asked for a guarantee it did not supply the means for.
   */
  keyRequired?: boolean;
  /**
   * The subject for a route with no actor.
   *
   * A public idempotent route still needs a subject, because a key must never be
   * shared across callers. Supplying one is an explicit decision, not a default.
   */
  publicSubject?: (context: { readonly headers: Headers }) => string;
  processingTtlMs?: number;
  completedTtlMs?: number;
}>;

/**
 * Builds the idempotency lifecycle for a route definition.
 *
 * The returned coordinator claims the key before the use case runs and hands
 * back the two settle calls the factory needs. The claim, the owner token, and
 * the TTLs stay inside the closure: there is no shared map, and nothing outlives
 * the request.
 */
export function idempotencyLifecycle<
  TInput extends RouteInputSchemas,
  TActor extends { readonly userId: string } | null,
  TOutput,
>(
  options: IdempotencyAdapterOptions<TOutput>,
): RouteIdempotency<TInput, TActor, TOutput> {
  function unavailable(): IdempotencyDecision<TOutput> {
    if (options.policy === AVAILABILITY_POLICY.REQUIRED) {
      throw new DependencyUnavailableError(
        "The idempotency store is unavailable.",
      );
    }

    // Degraded on purpose, and only because the definition asked for it: the use
    // case runs with no protection against a duplicate.
    return { outcome: IDEMPOTENCY_OUTCOME.PROCEED };
  }

  return async function beginAttempt(context) {
    const key = readIdempotencyKey(context.headers);

    if (!key) {
      if (options.keyRequired) {
        // A missing or malformed header is the caller's mistake, not a
        // dependency failure: it asked for a guarantee without supplying the
        // means, so it is refused as invalid input.
        throw new ValidationError(
          "The request did not carry a usable idempotency key.",
        );
      }

      return { outcome: IDEMPOTENCY_OUTCOME.PROCEED };
    }

    const subject =
      context.actor?.userId ??
      options.publicSubject?.({ headers: context.headers });

    if (subject === undefined) {
      // A key with no subject would be shared by every anonymous caller, so one
      // client's stored result could be replayed to another. This is a defect in
      // the route definition rather than anything the caller did, so it surfaces
      // as an internal error instead of blaming the request.
      throw new Error(
        "The route declares no idempotency subject for an unauthenticated caller.",
      );
    }

    const scope: IdempotencyScope = {
      routeName: context.routeName,
      apiVersion: options.apiVersion,
      subject,
      idempotencyKey: key,
    };

    const fingerprint = idempotencyFingerprint({
      method: context.method,
      routeName: context.routeName,
      params: context.params,
      query: context.query,
      body: context.body,
      actorId: context.actor?.userId ?? null,
    });

    const begun = await beginIdempotency({
      scope,
      fingerprint,
      outputSchema: options.outputSchema,
      ...(options.processingTtlMs === undefined
        ? {}
        : { processingTtlMs: options.processingTtlMs }),
      ...(options.completedTtlMs === undefined
        ? {}
        : { completedTtlMs: options.completedTtlMs }),
    });

    if (
      begun.status === IDEMPOTENCY_BEGIN_STATUS.DISABLED ||
      begun.status === IDEMPOTENCY_BEGIN_STATUS.UNAVAILABLE
    ) {
      return unavailable();
    }

    if (begun.status === IDEMPOTENCY_BEGIN_STATUS.CONFLICT) {
      return { outcome: IDEMPOTENCY_OUTCOME.CONFLICT };
    }

    if (begun.status === IDEMPOTENCY_BEGIN_STATUS.REPLAY) {
      return { outcome: IDEMPOTENCY_OUTCOME.REPLAY, output: begun.output };
    }

    const handle = begun.handle;

    return {
      outcome: IDEMPOTENCY_OUTCOME.PROCEED,
      reservation: {
        complete: async (output: TOutput) => {
          await completeIdempotency(handle, fingerprint, output);
        },
        abort: async () => {
          await abortIdempotency(handle);
        },
      },
    };
  };
}
