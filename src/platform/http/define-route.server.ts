import "server-only";

import type { NextRequest } from "next/server";
import type * as z from "zod";

import type { Actor } from "@/platform/auth/authorization/actor";
import {
  getActorFromHeaders,
  requireActor,
} from "@/platform/auth/authorization/actor.server";
import {
  AUTHORIZATION_MODE,
  type Authorization,
  type AuthorizedActor,
} from "@/platform/auth/authorization/authorization-mode";
import { runWithCallerHeaders } from "@/platform/auth/authorization/caller-headers.server";
import {
  requireAllPermissions,
  requireAnyPermission,
  requirePermission,
} from "@/platform/auth/authorization/require-permission.server";
import {
  assertInvalidationContext,
  INVALIDATION_CONTEXT,
} from "@/platform/cache/cache-invalidation";
import { runCacheInvalidation } from "@/platform/cache/cache-invalidation.server";
import type { PublicError } from "@/platform/errors/public-error";
import { toPublicError } from "@/platform/errors/to-public-error";
import { getRequestLogger } from "@/platform/observability/logger.server";
import { startOperationTimer } from "@/platform/observability/operation-timer.server";
import { runWithRequestContext } from "@/platform/observability/request-context.server";
import {
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "@/platform/observability/request-id.server";
import {
  isExpectedApplicationError,
  toSafeLogError,
} from "@/platform/observability/safe-error";
import {
  ConflictError,
  RateLimitedError,
  ValidationError,
} from "@/shared/errors/application-error";

import { HTTP_SUCCESS_STATUS, httpStatusForError } from "./http-response";
import { jsonError, jsonSuccess } from "./json-response";
import {
  ROUTE_LOG_EVENT,
  type RouteLogInput,
  toRouteLogFields,
} from "./log-event";
import { readJsonBody, toQueryRecord } from "./request-input";
import type {
  RouteContext,
  RouteFailureContext,
  RouteSuccessContext,
} from "./route-context";
import type { RouteDefinition, RouteHandler } from "./route-definition";
import type { RouteInputSchemas, RouteInputValues } from "./route-input";
import {
  IDEMPOTENCY_OUTCOME,
  RATE_LIMIT_OUTCOME,
  ROUTE_HOOK,
  ROUTE_STEP,
  type IdempotencyReservation,
  type RateLimitHook,
  type RouteStepName,
} from "./route-hooks";

/** The shape every observer hook shares. An observer's return value is ignored. */
type ObserverFunction<TContext> = (context: TContext) => void | Promise<void>;

/**
 * Parses one untrusted part of the request.
 *
 * `safeParseAsync` is used so a schema may carry a transform or an async
 * refinement. A part with no schema is not read at all: `read` is never called,
 * so an undeclared body is never consumed and an undeclared query is never
 * collected.
 *
 * The refusal is deliberately opaque. The thrown error carries a fixed diagnostic
 * message and nothing derived from the payload, so the resulting
 * `VALIDATION_FAILED` response can never disclose a Zod issue, a field name, a
 * field value, or the input itself.
 */
async function parsePart<TSchema extends z.ZodType | undefined>(
  schema: TSchema,
  read: () => unknown | Promise<unknown>,
): Promise<unknown> {
  if (!schema) {
    return undefined;
  }

  const parsed = await schema.safeParseAsync(await read());

  if (!parsed.success) {
    throw new ValidationError("The request input is not acceptable.");
  }

  return parsed.data;
}

/**
 * Validates the three parts independently.
 *
 * The order is params, query, body, and the body is read exactly once. An
 * undeclared part resolves to `undefined`, which is what its declared type says.
 */
async function parseRouteInput<TInput extends RouteInputSchemas>(
  schemas: TInput | undefined,
  request: NextRequest,
  routeContext: { params: Promise<unknown> },
): Promise<RouteInputValues<TInput>> {
  const params = await parsePart(schemas?.params, () => routeContext.params);
  const query = await parsePart(schemas?.query, () =>
    toQueryRecord(request.nextUrl.searchParams),
  );
  const body = await parsePart(schemas?.body, () => readJsonBody(request));

  return { params, query, body } as RouteInputValues<TInput>;
}

/**
 * Authenticates the caller, when the declared mode needs one.
 *
 * A public route reads no session at all: it never touches the auth provider, so
 * it cannot be slowed down or made to fail by it. The headers come from the
 * request being handled, never from ambient state.
 */
async function resolveActor(
  authorization: Authorization,
  requestHeaders: Headers,
): Promise<Actor | null> {
  if (authorization.mode === AUTHORIZATION_MODE.PUBLIC) {
    return null;
  }

  return requireActor(await getActorFromHeaders(requestHeaders));
}

/**
 * Requires the declared capability of an already authenticated actor.
 *
 * The decision is delegated to the central gate, which asks Better Auth using the
 * verified user id, so the role is read from the database rather than from a
 * session snapshot. No role name is compared here.
 *
 * The switch is exhaustive by construction: adding an authorization mode without
 * handling it leaves a code path with no return value and fails to compile.
 */
async function authorizeActor(
  actor: Actor,
  authorization: Authorization,
): Promise<Actor> {
  switch (authorization.mode) {
    case AUTHORIZATION_MODE.PUBLIC:
    case AUTHORIZATION_MODE.ACTOR:
      return actor;
    case AUTHORIZATION_MODE.PERMISSION:
      return requirePermission(actor, authorization.permission);
    case AUTHORIZATION_MODE.ANY_PERMISSION:
      return requireAnyPermission(actor, authorization.permissions);
    case AUTHORIZATION_MODE.ALL_PERMISSIONS:
      return requireAllPermissions(actor, authorization.permissions);
  }
}

/** Runs gate hooks in declaration order. A throw stops the sequence. */
async function runGateHooks<TContext>(
  hooks: readonly ObserverFunction<TContext>[] | undefined,
  context: TContext,
): Promise<void> {
  for (const hook of hooks ?? []) {
    await hook(context);
  }
}

function logHookFailure(
  base: RouteLogInput,
  hookName: RouteStepName,
  error: unknown,
): void {
  getRequestLogger().error(
    toRouteLogFields({
      ...base,
      hookName,
      errorCode: toSafeLogError(error).errorCode,
    }),
    ROUTE_LOG_EVENT.HOOK_FAILED,
  );
}

/**
 * Runs observer hooks in declaration order.
 *
 * An observer cannot change the outcome. Each one is isolated, so a failing
 * observer neither hides the original result nor prevents the observers declared
 * after it from running, and a committed mutation is never turned into a failure
 * a client would retry. The failure is recorded as a safe error code.
 */
async function runObserverHooks<TContext>(
  hooks: readonly ObserverFunction<TContext>[] | undefined,
  context: TContext,
  hookName: RouteStepName,
  base: RouteLogInput,
): Promise<void> {
  for (const hook of hooks ?? []) {
    try {
      await hook(context);
    } catch (error) {
      logHookFailure(base, hookName, error);
    }
  }
}

/**
 * A refusal that carries the caller's answer to "when may I come back?".
 *
 * `Retry-After` is written by the factory from a number the hook returned, never
 * by the hook itself. It is expressed in seconds and rounded up, because a
 * client that came back at a rounded-down second would be refused again.
 */
const RETRY_AFTER_HEADER = "retry-after";

function retryAfterSeconds(retryAfterMs: number): string {
  return String(Math.max(1, Math.ceil(retryAfterMs / 1_000)));
}

/**
 * Runs the rate-limit hooks. The first refusal ends the request.
 *
 * A refusal is the factory's own `RATE_LIMITED`, so every limiter answers the
 * same status and the same stable code, and no hook builds a response. The
 * refusal's `retryAfterMs` is handed back rather than thrown with the error, so
 * the header is attached where every other response header is.
 */
async function runRateLimitHooks<TContext>(
  hooks: readonly RateLimitHook[] | undefined,
  context: TContext & Parameters<RateLimitHook>[0],
): Promise<number | undefined> {
  for (const hook of hooks ?? []) {
    const decision = await hook(context);

    if (decision.outcome === RATE_LIMIT_OUTCOME.REFUSED) {
      return decision.retryAfterMs ?? 0;
    }
  }

  return undefined;
}

/**
 * The single Route Handler adapter.
 *
 * Every application endpoint is built here, so request correlation, validation,
 * authentication, authorization, hook orchestration, error normalization,
 * response serialization, and request logging are written once instead of once
 * per route. The order is fixed, and it is the reason a use case can trust its
 * arguments:
 *
 *  1. resolve or create the request id and open the request context;
 *  2. log `route.started`;
 *  3. run the rate-limit hooks;
 *  4. validate params, query, and body;
 *  5. resolve the actor, when the mode needs one;
 *  6. authenticate, then authorize;
 *  7. begin the idempotency lifecycle, then `beforeExecute`;
 *  8. run the use case;
 *  9. complete the idempotency reservation;
 * 10. run `afterSuccess`, then cache invalidation, then `audit`;
 * 11. serialize the envelope;
 * 12. log the completion.
 *
 * A failure before the use case commits runs the reverse of step 9 — the
 * reservation is aborted — then `afterFailure`, then the safe response.
 *
 * Steps 9, 10, and the order within 10 are deliberate, and the reasoning is
 * worth stating because all three run after the mutation has committed and
 * none of them can be rolled back:
 *
 * - **Completion first.** Recording the result is what makes an immediate retry
 *   cheap instead of a duplicate operation, and it is the only post-success step
 *   whose absence changes what a *client* observes. It therefore runs as close
 *   to the commit as possible, before any observer that might be slow.
 * - **Invalidation before audit.** Invalidation is what the next reader sees;
 *   audit is what an operator reads later. Purging first shortens the stale
 *   window, and an audit record written a few milliseconds later is still
 *   correct.
 * - **Audit last.** It is the step most likely to be extended over time, and
 *   putting it last means growth there cannot delay the two steps that affect
 *   correctness.
 *
 * None of the three can turn a committed mutation into a failure. Each is
 * isolated, its failure is logged with a safe error code, and the success
 * response stands — an observer must never produce a response a client would
 * retry against a mutation that already happened.
 *
 * Authorization always precedes the use case and any resource lookup, so a caller
 * without the capability is refused whether or not the target exists. `execute`
 * is unreachable when a rate limit refuses, when any part is invalid, when the
 * actor is missing, when the capability is missing, when idempotency reports a
 * conflict or a replay, when a required control is unavailable, and when a
 * `beforeExecute` hook throws.
 *
 * This adapter owns no business logic. It reaches no database, no repository, and
 * no business module; it performs no redirect and mutates no cookie. It resolves
 * rather than throws: every outcome, including a refusal, is a JSON envelope
 * carrying `x-request-id`.
 */
export function defineRoute<
  TInput extends RouteInputSchemas,
  TAuthorization extends Authorization,
  TOutput,
>(definition: RouteDefinition<TInput, TAuthorization, TOutput>): RouteHandler {
  type ResolvedActor = AuthorizedActor<TAuthorization>;

  // Checked when the route is defined, which is module load, so a Route Handler
  // that declared a Server Action-only tag strategy fails at startup and in the
  // test suite rather than in the post-success step of a real mutation, where
  // the only possible response is a logged warning.
  assertInvalidationContext(
    definition.revalidate,
    INVALIDATION_CONTEXT.ROUTE_HANDLER,
  );

  return async function runRoute(
    request: NextRequest,
    routeContext: { params: Promise<unknown> },
  ): Promise<Response> {
    const timer = startOperationTimer();
    const routeName = definition.name;
    const method = request.method;
    const successStatus = definition.successStatus ?? HTTP_SUCCESS_STATUS.OK;

    // A client-supplied correlation id is reused only when it satisfies the
    // bounded UUID v4 contract; anything else is replaced. The value is resolved
    // before any other work so every line of this request, and the response
    // itself, carry the same id even when the first step is the one that fails.
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const responseHeaders: Record<string, string> = {
      [REQUEST_ID_HEADER]: requestId,
    };

    return runWithRequestContext({ requestId }, () =>
      // Server services delegate to Better Auth on the caller's behalf and need
      // the caller's headers for it. They are put in the request scope here so a
      // use case never has to be handed them.
      runWithCallerHeaders(request.headers, async () => {
        // Rebuilt once an actor exists, so a refusal is attributable and nothing
        // the allowlist does not name is ever carried.
        let logBase: RouteLogInput = { routeName, method, requestId };

        getRequestLogger().info(
          toRouteLogFields(logBase),
          ROUTE_LOG_EVENT.STARTED,
        );

        let inputs: RouteInputValues<TInput> | null = null;
        let resolvedActor: Actor | null = null;
        // Held so the failure path can release a claim the use case never got to
        // fulfil. It is a local, not a shared map: nothing survives this request.
        let reservation: IdempotencyReservation<TOutput> | undefined;

        try {
          const refusedAfterMs = await runRateLimitHooks(
            definition.hooks?.rateLimit,
            {
              routeName,
              method,
              requestId,
              headers: request.headers,
            },
          );

          if (refusedAfterMs !== undefined) {
            if (refusedAfterMs > 0) {
              responseHeaders[RETRY_AFTER_HEADER] =
                retryAfterSeconds(refusedAfterMs);
            }

            throw new RateLimitedError("The caller exceeded the allowed rate.");
          }

          inputs = await parseRouteInput(
            definition.input,
            request,
            routeContext,
          );

          resolvedActor = await resolveActor(
            definition.authorization,
            request.headers,
          );

          logBase = { routeName, method, requestId, actor: resolvedActor };

          if (resolvedActor) {
            await authorizeActor(resolvedActor, definition.authorization);
          }

          // A conditional type cannot be established by control flow. The mode
          // dispatch above enforces exactly what `AuthorizedActor` states —
          // `null` for a public route, a resolved `Actor` for every other mode —
          // and this is the single point where the runtime union and the
          // declared type are joined.
          const actor = resolvedActor as ResolvedActor;

          const context: RouteContext<TInput, ResolvedActor> = {
            routeName,
            requestId,
            ...inputs,
            actor,
          };

          if (definition.idempotency) {
            const decision = await definition.idempotency({
              ...context,
              method,
              headers: request.headers,
            });

            if (decision.outcome === IDEMPOTENCY_OUTCOME.CONFLICT) {
              throw new ConflictError(
                "The idempotency key is already in use by a different or unfinished request.",
              );
            }

            if (decision.outcome === IDEMPOTENCY_OUTCOME.REPLAY) {
              getRequestLogger().info(
                toRouteLogFields({
                  ...logBase,
                  durationMs: timer.elapsedMs(),
                  statusCode: successStatus,
                  replayed: true,
                }),
                ROUTE_LOG_EVENT.REPLAYED,
              );

              return jsonSuccess(
                decision.output,
                successStatus,
                responseHeaders,
              );
            }

            reservation = decision.reservation;
          }

          await runGateHooks(definition.hooks?.beforeExecute, context);

          const output = await definition.execute(context);

          // Everything below this line runs after the use case has committed and
          // is not transactional with it. A failure is recorded and the success
          // response stands.
          const successContext: RouteSuccessContext<
            TInput,
            ResolvedActor,
            TOutput
          > = { ...context, output };

          if (reservation) {
            await runObserverHooks(
              [reservation.complete],
              output,
              ROUTE_STEP.IDEMPOTENCY,
              logBase,
            );
          }

          await runObserverHooks(
            definition.hooks?.afterSuccess,
            successContext,
            ROUTE_HOOK.AFTER_SUCCESS,
            logBase,
          );

          await runObserverHooks(
            [
              async () => {
                await runCacheInvalidation(
                  definition.revalidate,
                  INVALIDATION_CONTEXT.ROUTE_HANDLER,
                );
              },
            ],
            undefined,
            ROUTE_STEP.CACHE_INVALIDATION,
            logBase,
          );

          await runObserverHooks(
            definition.hooks?.audit,
            successContext,
            ROUTE_HOOK.AUDIT,
            logBase,
          );

          const response = jsonSuccess(output, successStatus, responseHeaders);

          getRequestLogger().info(
            toRouteLogFields({
              ...logBase,
              durationMs: timer.elapsedMs(),
              statusCode: successStatus,
            }),
            ROUTE_LOG_EVENT.SUCCEEDED,
          );

          return response;
        } catch (error) {
          const publicError: PublicError = toPublicError(error);
          const durationMs = timer.elapsedMs();

          const failureContext: RouteFailureContext<TInput, ResolvedActor> = {
            routeName,
            requestId,
            input: inputs,
            actor: resolvedActor as ResolvedActor | null,
            error: publicError,
          };

          // Released before anything else, so the retry the client is about to
          // send is not refused by a claim whose attempt is already over. It is
          // isolated for the same reason every post-outcome step is: a failed
          // release must not replace the failure the caller needs to see.
          if (reservation) {
            await runObserverHooks(
              [reservation.abort],
              undefined,
              ROUTE_STEP.IDEMPOTENCY,
              logBase,
            );
          }

          await runObserverHooks(
            definition.hooks?.afterFailure,
            failureContext,
            ROUTE_HOOK.AFTER_FAILURE,
            logBase,
          );

          const fields = toRouteLogFields({
            ...logBase,
            durationMs,
            statusCode: httpStatusForError(publicError.code),
            errorCode: publicError.code,
          });
          const log = getRequestLogger();

          // A refused request is expected traffic; an unexpected failure is not.
          if (isExpectedApplicationError(error)) {
            log.warn(fields, ROUTE_LOG_EVENT.FAILED);
          } else {
            log.error(fields, ROUTE_LOG_EVENT.FAILED);
          }

          return jsonError(error, responseHeaders);
        }
      }),
    );
  };
}
