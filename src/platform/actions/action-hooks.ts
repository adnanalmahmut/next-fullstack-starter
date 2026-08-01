import type {
  ActionContext,
  ActionFailureContext,
  ActionSuccessContext,
} from "./action-context";

/**
 * The three lifecycle hooks an Action definition may declare.
 *
 * The set is closed. A hook cannot be added by a call site, cannot run before
 * validation, and cannot take part in the authorization decision: the factory
 * owns the order, and `beforeExecute` is the earliest point any declared code
 * runs.
 */
export const ACTION_HOOK = {
  BEFORE_EXECUTE: "beforeExecute",
  AFTER_SUCCESS: "afterSuccess",
  AFTER_FAILURE: "afterFailure",
} as const;

export type ActionHookName = (typeof ACTION_HOOK)[keyof typeof ACTION_HOOK];

export const ACTION_HOOK_NAMES: readonly ActionHookName[] =
  Object.values(ACTION_HOOK);

/**
 * Cache invalidation is not a declarable hook. It is the factory's own final
 * post-success step, and it is reported under this name when it fails.
 */
export const CACHE_INVALIDATION_STEP = "cacheInvalidation" as const;

/** Every step name that can appear in a `server_action.hook_failed` line. */
export type ActionStepName = ActionHookName | typeof CACHE_INVALIDATION_STEP;

/**
 * A gate that runs after validation and authorization and before the use case.
 *
 * Throwing prevents the use case from running and turns the call into a normal
 * failure result. This is the only hook that can stop execution.
 */
export type BeforeExecuteHook<TInput, TActor> = (
  context: ActionContext<TInput, TActor>,
) => void | Promise<void>;

/**
 * An observer that runs only after the use case succeeded.
 *
 * It is where an Action declaration records an audit entry with allowlisted data.
 * It is not transactional with the use case: the mutation has already committed,
 * so throwing here is recorded and the success result stands.
 */
export type AfterSuccessHook<TInput, TActor, TOutput> = (
  context: ActionSuccessContext<TInput, TActor, TOutput>,
) => void | Promise<void>;

/**
 * An observer that runs only after a validation, authorization, `beforeExecute`,
 * or use case failure. Throwing here is recorded and the original failure stands.
 */
export type AfterFailureHook<TInput, TActor> = (
  context: ActionFailureContext<TInput, TActor>,
) => void | Promise<void>;

/** Hooks run sequentially, in declaration order, within each list. */
export type ActionHooks<TInput, TActor, TOutput> = Readonly<{
  beforeExecute?: readonly BeforeExecuteHook<TInput, TActor>[];
  afterSuccess?: readonly AfterSuccessHook<TInput, TActor, TOutput>[];
  afterFailure?: readonly AfterFailureHook<TInput, TActor>[];
}>;
