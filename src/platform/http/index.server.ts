import "server-only";

/**
 * The controlled server-only entry point for Route Handlers.
 *
 * A `route.ts` imports the factory and the authorization modes from here and
 * nothing else. The response contract itself stays importable on its own from
 * `http-response.ts`, so a caller that only needs to read an envelope does not
 * pull the factory in with it.
 */
export { defineRoute } from "./define-route.server";

export {
  AUTHORIZATION_MODE,
  AUTHORIZATION_MODES,
  type ActorAuthorization,
  type AllPermissionsAuthorization,
  type AnyPermissionAuthorization,
  type Authorization,
  type AuthorizationMode,
  type AuthorizedActor,
  type PermissionAuthorization,
  type PublicAuthorization,
} from "@/platform/auth/authorization/authorization-mode";

export type {
  RouteDefinition,
  RouteExecute,
  RouteHandler,
} from "./route-definition";

export type {
  RouteInputSchemas,
  RouteInputValue,
  RouteInputValues,
} from "./route-input";

export type {
  RouteContext,
  RouteFailureContext,
  RouteIdempotencyContext,
  RouteRequestContext,
  RouteSuccessContext,
} from "./route-context";

export {
  IDEMPOTENCY_OUTCOME,
  RATE_LIMIT_OUTCOME,
  ROUTE_HOOK,
  ROUTE_HOOK_NAMES,
  type AfterFailureHook,
  type AfterSuccessHook,
  type AuditHook,
  type BeforeExecuteHook,
  type IdempotencyDecision,
  type IdempotencyHook,
  type RateLimitHook,
  type RateLimitOutcome,
  type RouteHookName,
  type RouteHooks,
} from "./route-hooks";

export {
  ROUTE_LOG_EVENT,
  toRouteLogFields,
  type RouteLogEvent,
  type RouteLogFields,
  type RouteLogInput,
} from "./log-event";

export { toQueryRecord, type QueryRecord } from "./request-input";

export {
  HTTP_STATUS_BY_ERROR_CODE,
  HTTP_SUCCESS_STATUS,
  httpStatusForError,
  type HttpErrorResponse,
  type HttpErrorStatus,
  type HttpResponse,
  type HttpSuccessResponse,
  type HttpSuccessStatus,
} from "./http-response";
