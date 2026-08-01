import "server-only";

/**
 * The controlled server-only entry point for Server Actions.
 *
 * An Action definition file imports the factory from here. The client-safe result
 * contract stays importable on its own from `action-result.ts`, so presentation
 * code reads an `ActionResult` without pulling the factory into the bundle.
 */
export { defineAction } from "./define-action.server";

export {
  AUTHORIZATION_MODE,
  AUTHORIZATION_MODES,
  type ActionActor,
  type ActionAuthorization,
  type ActionDefinition,
  type ActionExecute,
  type AllPermissionsAuthorization,
  type AnyPermissionAuthorization,
  type ActorAuthorization,
  type AuthorizationMode,
  type PermissionAuthorization,
  type PublicAuthorization,
  type ServerAction,
} from "./action-definition";

export type {
  ActionContext,
  ActionFailureContext,
  ActionSuccessContext,
} from "./action-context";

export {
  ACTION_HOOK,
  ACTION_HOOK_NAMES,
  CACHE_INVALIDATION_STEP,
  type ActionHookName,
  type ActionHooks,
  type ActionStepName,
  type AfterFailureHook,
  type AfterSuccessHook,
  type BeforeExecuteHook,
} from "./action-hooks";

export {
  DEFAULT_REVALIDATE_PROFILE,
  REVALIDATE_PATH_TYPE,
  hasCacheInvalidation,
  runCacheInvalidation,
  type CacheInvalidation,
  type CachePathInvalidation,
  type CacheTagInvalidation,
  type RevalidatePathType,
  type RevalidateProfile,
} from "./cache-invalidation.server";

export {
  ACTION_OUTCOME,
  SERVER_ACTION_LOG_EVENT,
  toServerActionLogFields,
  type ServerActionLogEvent,
  type ServerActionLogFields,
  type ServerActionLogInput,
} from "./log-event";

export {
  actionFailure,
  actionSuccess,
  type ActionFailure,
  type ActionResult,
  type ActionSuccess,
} from "./action-result";
