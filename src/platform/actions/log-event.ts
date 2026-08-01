import {
  LOG_STATUS,
  type LogStatus,
} from "@/platform/observability/log-context";
import type { ErrorCode } from "@/shared/errors/error-code";

import type { ActionStepName } from "./action-hooks";

/**
 * Stable log event names for the Server Action boundary.
 *
 * They are language neutral identifiers, not user-facing text. A Server Action
 * log line carries only the fields `ServerActionLogFields` declares, and nothing
 * else: never the input, the output, a `FormData` body, a credential, an email
 * address, a display name, a raw error, a stack trace, or a Zod issue.
 */
export const SERVER_ACTION_LOG_EVENT = {
  STARTED: "server_action.started",
  SUCCEEDED: "server_action.succeeded",
  FAILED: "server_action.failed",
  HOOK_FAILED: "server_action.hook_failed",
} as const;

export type ServerActionLogEvent =
  (typeof SERVER_ACTION_LOG_EVENT)[keyof typeof SERVER_ACTION_LOG_EVENT];

/**
 * The complete allowlist of fields a Server Action log line may carry.
 *
 * The type is closed on purpose. Widening it is the only way to log a new field,
 * which makes an accidental payload leak a reviewed change rather than a typo.
 */
export type ServerActionLogFields = Readonly<{
  actionName: string;
  requestId?: string;
  actorUserId?: string;
  durationMs?: number;
  outcome?: LogStatus;
  errorCode?: ErrorCode;
  hookName?: ActionStepName;
}>;

/**
 * The source values the factory has in hand at a log point.
 *
 * An actor is accepted whole and reduced to its user id here, so the actor's
 * name, email address, session id, and roles have exactly one place where they
 * are dropped rather than one place per call site.
 */
export type ServerActionLogInput = Readonly<{
  actionName: string;
  requestId?: string | undefined;
  actor?: Readonly<{ userId: string }> | null | undefined;
  durationMs?: number | undefined;
  outcome?: LogStatus | undefined;
  errorCode?: ErrorCode | undefined;
  hookName?: ActionStepName | undefined;
}>;

/**
 * Builds the log payload for a Server Action event.
 *
 * Absent values are omitted rather than serialized as `null`, so a log line
 * never claims to know something it does not.
 */
export function toServerActionLogFields(
  input: ServerActionLogInput,
): ServerActionLogFields {
  return {
    actionName: input.actionName,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.actor ? { actorUserId: input.actor.userId } : {}),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.hookName === undefined ? {} : { hookName: input.hookName }),
  };
}

/** The outcome value reported by a terminal Server Action event. */
export const ACTION_OUTCOME = {
  SUCCEEDED: LOG_STATUS.SUCCEEDED,
  FAILED: LOG_STATUS.FAILED,
} as const;
