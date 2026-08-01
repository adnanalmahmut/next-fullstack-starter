import type { PublicError } from "@/platform/errors/public-error";

import type { RouteInputSchemas, RouteInputValues } from "./route-input";

/**
 * The context the use case and the use-case-level hooks receive.
 *
 * It carries the validated parts, the resolved actor, and the correlation id, and
 * nothing else. There is no `NextRequest`, no `Headers`, no cookie, and no
 * session token here on purpose: a use case that could read those could
 * authenticate on its own, which is precisely what this boundary exists to
 * prevent.
 *
 * `TActor` is resolved from the authorization mode, so a protected route reads a
 * guaranteed `Actor` and a public route reads `null`.
 */
export type RouteContext<TInput extends RouteInputSchemas, TActor> = Readonly<
  RouteInputValues<TInput> & {
    /** The stable route identifier used in logs. Never user-facing text. */
    routeName: string;
    actor: TActor;
    /** Always present: the factory resolves or creates one before anything else. */
    requestId: string;
  }
>;

/** The context for a step that runs after the use case succeeded. */
export type RouteSuccessContext<
  TInput extends RouteInputSchemas,
  TActor,
  TOutput,
> = Readonly<
  RouteContext<TInput, TActor> & {
    output: TOutput;
  }
>;

/**
 * The context for a step that runs after a failure.
 *
 * `input` and `actor` are nullable because a failure can happen before either
 * exists: a refused rate limit leaves no input at all, refused validation leaves
 * no parsed parts, and a missing actor leaves no actor. `error` is the normalized
 * public error, never the raw thrown value, so a failure observer cannot read a
 * message, a stack trace, or a provider payload.
 */
export type RouteFailureContext<
  TInput extends RouteInputSchemas,
  TActor,
> = Readonly<{
  routeName: string;
  requestId: string;
  input: RouteInputValues<TInput> | null;
  actor: TActor | null;
  error: PublicError;
}>;

/**
 * The context an infrastructure hook receives.
 *
 * Rate limiting and idempotency are transport concerns: one has to see the
 * caller's address or key, the other has to see an idempotency key. They are the
 * only steps allowed to read request metadata, and they are given a copy of the
 * headers rather than the request itself, so they can read but cannot rewrite
 * what the factory already decided.
 */
export type RouteRequestContext = Readonly<{
  routeName: string;
  method: string;
  requestId: string;
  headers: Headers;
}>;

/**
 * The context the idempotency hook receives.
 *
 * It runs after validation and authorization, so it sees the validated parts and
 * the authorized actor as well as the request metadata it needs to find a stored
 * result.
 */
export type RouteIdempotencyContext<
  TInput extends RouteInputSchemas,
  TActor,
> = Readonly<
  RouteContext<TInput, TActor> & { method: string; headers: Headers }
>;
