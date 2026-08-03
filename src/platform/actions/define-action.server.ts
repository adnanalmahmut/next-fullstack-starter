import "server-only";

import type * as z from "zod";

import {
  actionFailure,
  actionSuccess,
  type ActionResult,
} from "@/platform/actions/action-result";
import type { Actor } from "@/platform/auth/authorization/actor";
import {
  getCurrentActor,
  requireActor,
} from "@/platform/auth/authorization/actor.server";
import {
  requireAllPermissions,
  requireAnyPermission,
  requirePermission,
} from "@/platform/auth/authorization/require-permission.server";
import { INVALIDATION_CONTEXT } from "@/platform/cache/cache-invalidation";
import { runCacheInvalidation } from "@/platform/cache/cache-invalidation.server";
import type { PublicError } from "@/platform/errors/public-error";
import { toPublicError } from "@/platform/errors/to-public-error";
import { getRequestLogger } from "@/platform/observability/logger.server";
import { startOperationTimer } from "@/platform/observability/operation-timer.server";
import { getRequestContext } from "@/platform/observability/request-context.server";
import {
  isExpectedApplicationError,
  toSafeLogError,
} from "@/platform/observability/safe-error";
import { SPAN_OUTCOME } from "@/platform/observability/tracing.server";
import { ValidationError } from "@/shared/errors/application-error";

import { withActionTelemetry } from "./action-telemetry.server";
import type {
  ActionContext,
  ActionFailureContext,
  ActionSuccessContext,
} from "./action-context";
import {
  AUTHORIZATION_MODE,
  type ActionActor,
  type ActionAuthorization,
  type ActionDefinition,
  type ServerAction,
} from "./action-definition";
import {
  ACTION_HOOK,
  CACHE_INVALIDATION_STEP,
  type ActionStepName,
} from "./action-hooks";
import {
  ACTION_OUTCOME,
  SERVER_ACTION_LOG_EVENT,
  toServerActionLogFields,
  type ServerActionLogInput,
} from "./log-event";

/** The shape every lifecycle hook shares. A hook's return value is ignored. */
type HookFunction<TContext> = (context: TContext) => void | Promise<void>;

/**
 * Parses the untrusted argument.
 *
 * `safeParseAsync` is used so a schema may carry a transform or an async
 * refinement. The refusal is deliberately opaque: the thrown error carries a
 * fixed diagnostic message and nothing derived from the payload, so the resulting
 * `VALIDATION_FAILED` result can never disclose a Zod issue, a field name, a
 * field value, or the input itself.
 */
async function parseActionInput<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
): Promise<z.output<TSchema>> {
  const parsed = await schema.safeParseAsync(input);

  if (!parsed.success) {
    throw new ValidationError("The Server Action input is not acceptable.");
  }

  return parsed.data;
}

/**
 * Authenticates the caller, when the declared mode needs one.
 *
 * A public Action reads no session at all: it never touches the auth provider, so
 * it cannot be slowed down or made to fail by it.
 */
async function resolveActor(
  authorization: ActionAuthorization,
): Promise<Actor | null> {
  if (authorization.mode === AUTHORIZATION_MODE.PUBLIC) {
    return null;
  }

  return requireActor(await getCurrentActor());
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
  authorization: ActionAuthorization,
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
  hooks: readonly HookFunction<TContext>[] | undefined,
  context: TContext,
): Promise<void> {
  for (const hook of hooks ?? []) {
    await hook(context);
  }
}

function logStepFailure(
  base: ServerActionLogInput,
  step: ActionStepName,
  error: unknown,
): void {
  getRequestLogger().error(
    toServerActionLogFields({
      ...base,
      hookName: step,
      errorCode: toSafeLogError(error).errorCode,
    }),
    SERVER_ACTION_LOG_EVENT.HOOK_FAILED,
  );
}

/**
 * Runs observer hooks in declaration order.
 *
 * An observer cannot change the outcome. Each one is isolated, so a failing
 * observer neither hides the original result nor prevents the observers declared
 * after it from running. The failure is recorded as a safe error code.
 */
async function runObserverHooks<TContext>(
  hooks: readonly HookFunction<TContext>[] | undefined,
  context: TContext,
  step: ActionStepName,
  base: ServerActionLogInput,
): Promise<void> {
  for (const hook of hooks ?? []) {
    try {
      await hook(context);
    } catch (error) {
      logStepFailure(base, step, error);
    }
  }
}

/**
 * The single Server Action adapter.
 *
 * Every Server Action in the application is built here, so validation, actor
 * resolution, authorization, error normalization, lifecycle hooks, logging, and
 * `ActionResult` construction are written once instead of once per Action. The
 * order is fixed, and it is the reason a use case can trust its arguments:
 *
 * 1. Validate the input.
 * 2. Resolve the current actor, when the mode needs one.
 * 3. Authenticate, then authorize.
 * 4. Run `beforeExecute` hooks.
 * 5. Run the use case.
 * 6. Run `afterSuccess` hooks, then cache invalidation.
 * 7. Return `actionSuccess`.
 *
 * `execute` is unreachable when the input is invalid, when the actor is missing,
 * when the capability is missing, and when a `beforeExecute` hook throws.
 *
 * The returned callable resolves rather than throws: every outcome, including a
 * refusal, is an `ActionResult`. Its argument is `unknown` because a Server Action
 * argument crosses the network and is untrusted until the schema has parsed it.
 *
 * This adapter owns no business logic. It reaches no database, no repository, and
 * no business module; it produces no HTTP response, performs no redirect, and
 * mutates no cookie. It calls `execute` and nothing else.
 */
export function defineAction<
  TSchema extends z.ZodType,
  TAuthorization extends ActionAuthorization,
  TOutput,
>(
  definition: ActionDefinition<TSchema, TAuthorization, TOutput>,
): ServerAction<TOutput> {
  type Input = z.output<TSchema>;
  type ResolvedActor = ActionActor<TAuthorization>;

  return async function runAction(
    input: unknown,
  ): Promise<ActionResult<TOutput>> {
    const timer = startOperationTimer();
    const actionName = definition.name;
    const requestId = getRequestContext()?.requestId;

    // The span and the execution metric wrap the whole action — validation,
    // authorization, the hooks, the use case, and the cache invalidation — because
    // that is what the caller waited for. It changes no ordering and no
    // `ActionResult`: the body reports its outcome and the wrapper records it.
    return withActionTelemetry(actionName, requestId, async (telemetry) => {
      // Rebuilt at each log point so it always carries the actor once one exists,
      // and never carries anything the allowlist does not name.
      let logBase: ServerActionLogInput = { actionName, requestId };

      getRequestLogger().info(
        toServerActionLogFields(logBase),
        SERVER_ACTION_LOG_EVENT.STARTED,
      );

      let validatedInput: Input | null = null;
      let resolvedActor: Actor | null = null;

      try {
        validatedInput = await parseActionInput(definition.input, input);

        resolvedActor = await resolveActor(definition.authorization);

        // Bound before the capability check, so a refusal is attributable: a
        // `FORBIDDEN` line names the caller that was denied.
        logBase = { actionName, requestId, actor: resolvedActor };

        if (resolvedActor) {
          await authorizeActor(resolvedActor, definition.authorization);
        }

        // A conditional type cannot be established by control flow. The mode
        // dispatch above enforces exactly what `ActionActor` states — `null` for
        // a public Action, a resolved `Actor` for every other mode — and this is
        // the single point where the runtime union and the declared type are
        // joined.
        const actor = resolvedActor as ResolvedActor;

        const context: ActionContext<Input, ResolvedActor> = {
          actionName,
          input: validatedInput,
          actor,
          ...(requestId === undefined ? {} : { requestId }),
        };

        await runGateHooks(definition.hooks?.beforeExecute, context);

        const output = await definition.execute(context);

        getRequestLogger().info(
          toServerActionLogFields({
            ...logBase,
            durationMs: timer.elapsedMs(),
            outcome: ACTION_OUTCOME.SUCCEEDED,
          }),
          SERVER_ACTION_LOG_EVENT.SUCCEEDED,
        );

        // Reported as soon as the use case has succeeded, so an observer or an
        // invalidation failure below — neither of which changes the result —
        // cannot change the recorded outcome either.
        telemetry.report(SPAN_OUTCOME.SUCCEEDED);

        // Everything below this line runs after the mutation has committed and is
        // not transactional with it. A failure is recorded and the success stands.
        const successContext: ActionSuccessContext<
          Input,
          ResolvedActor,
          TOutput
        > = { ...context, output };

        await runObserverHooks(
          definition.hooks?.afterSuccess,
          successContext,
          ACTION_HOOK.AFTER_SUCCESS,
          logBase,
        );

        try {
          // The plan reports rather than throws: one unreachable target must not
          // stop the others from being purged, and none of them may turn a
          // committed mutation into a failure the client would retry.
          await runCacheInvalidation(
            definition.revalidate,
            INVALIDATION_CONTEXT.SERVER_ACTION,
          );
        } catch (error) {
          logStepFailure(logBase, CACHE_INVALIDATION_STEP, error);
        }

        return actionSuccess(output);
      } catch (error) {
        const publicError: PublicError = toPublicError(error);
        const durationMs = timer.elapsedMs();

        const failureContext: ActionFailureContext<Input, ResolvedActor> = {
          actionName,
          input: validatedInput,
          actor: resolvedActor as ResolvedActor | null,
          ...(requestId === undefined ? {} : { requestId }),
          error: publicError,
        };

        await runObserverHooks(
          definition.hooks?.afterFailure,
          failureContext,
          ACTION_HOOK.AFTER_FAILURE,
          logBase,
        );

        const fields = toServerActionLogFields({
          ...logBase,
          durationMs,
          outcome: ACTION_OUTCOME.FAILED,
          errorCode: publicError.code,
        });
        const log = getRequestLogger();

        // A refused call is expected traffic; an unexpected failure is not.
        if (isExpectedApplicationError(error)) {
          log.warn(fields, SERVER_ACTION_LOG_EVENT.FAILED);
        } else {
          log.error(fields, SERVER_ACTION_LOG_EVENT.FAILED);

          // This boundary owns the unexpected failures it turns into an
          // `ActionResult`. The error never escapes to Next.js, so
          // `onRequestError` will not see it and it is reported exactly once.
          telemetry.captureFailure(error, publicError.code);
        }

        telemetry.report(SPAN_OUTCOME.FAILED, publicError.code);

        return actionFailure(publicError);
      }
    });
  };
}
