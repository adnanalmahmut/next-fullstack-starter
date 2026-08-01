import type { ErrorCode } from "@/shared/errors/error-code";

import type { RouteStepName } from "./route-hooks";

/**
 * Stable log event names for the Route Handler boundary.
 *
 * They are language neutral identifiers, not user-facing text. A route log line
 * carries only the fields `RouteLogFields` declares, and nothing else: never the
 * body, a query value, a params value, the output, a password, a token, a cookie,
 * an authorization header, an email address, a name, the full URL, a raw error, a
 * stack trace, or a Zod issue.
 */
export const ROUTE_LOG_EVENT = {
  STARTED: "route.started",
  SUCCEEDED: "route.succeeded",
  FAILED: "route.failed",
  HOOK_FAILED: "route.hook_failed",
  REPLAYED: "route.replayed",
} as const;

export type RouteLogEvent =
  (typeof ROUTE_LOG_EVENT)[keyof typeof ROUTE_LOG_EVENT];

/**
 * The complete allowlist of fields a route log line may carry.
 *
 * The type is closed on purpose. Widening it is the only way to log a new field,
 * which makes an accidental payload leak a reviewed change rather than a typo.
 */
export type RouteLogFields = Readonly<{
  routeName: string;
  method: string;
  requestId: string;
  actorUserId?: string;
  durationMs?: number;
  statusCode?: number;
  errorCode?: ErrorCode;
  hookName?: RouteStepName;
  replayed?: boolean;
}>;

/**
 * The source values the factory has in hand at a log point.
 *
 * An actor is accepted whole and reduced to its user id here, so the actor's
 * name, email address, session id, and roles have exactly one place where they
 * are dropped rather than one place per call site.
 */
export type RouteLogInput = Readonly<{
  routeName: string;
  method: string;
  requestId: string;
  actor?: Readonly<{ userId: string }> | null | undefined;
  durationMs?: number | undefined;
  statusCode?: number | undefined;
  errorCode?: ErrorCode | undefined;
  hookName?: RouteStepName | undefined;
  replayed?: boolean | undefined;
}>;

/**
 * Builds the log payload for a route event.
 *
 * Absent values are omitted rather than serialized as `null`, so a log line never
 * claims to know something it does not.
 */
export function toRouteLogFields(input: RouteLogInput): RouteLogFields {
  return {
    routeName: input.routeName,
    method: input.method,
    requestId: input.requestId,
    ...(input.actor ? { actorUserId: input.actor.userId } : {}),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.hookName === undefined ? {} : { hookName: input.hookName }),
    ...(input.replayed === undefined ? {} : { replayed: input.replayed }),
  };
}
