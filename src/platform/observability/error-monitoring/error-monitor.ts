import { ApplicationError } from "@/shared/errors/application-error";
import { ERROR_CODE, type ErrorCode } from "@/shared/errors/error-code";

/**
 * The provider-neutral error-monitoring port.
 *
 * Everything above this file is written against these types and never against a
 * vendor SDK, which is what keeps `@sentry/node` inside one adapter file and makes
 * replacing the provider — or deleting error monitoring entirely — a change to one
 * directory. The reasoning behind choosing Sentry as the reference adapter, and
 * behind refusing its tracing, is recorded in
 * `docs/adr/0002-server-error-monitoring.md`.
 *
 * The port is deliberately tiny: capture one unexpected failure, flush, shut down.
 * There is no `captureMessage`, no breadcrumb API, no user-context setter, no
 * transaction API, and no scope object. An operation that does not exist here
 * cannot be reached from a call site, so "this application never attaches a user
 * to an error report" is a property of this interface rather than a rule somebody
 * has to review for.
 */

/**
 * Which boundary turned an error into a response, a result, or a retry.
 *
 * The set is closed, and it is what makes ownership reviewable: exactly one
 * boundary reports any given failure, so the same error is never sent twice from
 * two layers.
 */
export const ERROR_BOUNDARY = {
  /** An unhandled error Next.js reported through `onRequestError`. */
  REQUEST: "request",
  /** An unexpected failure `defineRoute` turned into a response. */
  ROUTE: "route",
  /** An unexpected failure `defineAction` turned into an `ActionResult`. */
  SERVER_ACTION: "server_action",
  /** A job's final or permanent failure. Never a transient retry. */
  JOB: "job",
  /** An unexpected failure that threatens the outbox dispatcher loop. */
  OUTBOX: "outbox",
} as const;

export type ErrorBoundary =
  (typeof ERROR_BOUNDARY)[keyof typeof ERROR_BOUNDARY];

/**
 * The complete allowlist of context an error report may carry.
 *
 * It is the same discipline as the log-field allowlists, applied to a payload that
 * leaves the deployment entirely. A capture may name the boundary, the operation,
 * the stable error code, the request id, the trace id, and — for a job — the
 * closed job identity. It may never carry an actor, a user id, an email address, a
 * role, an input, an output, a payload, a result, a header, a cookie, a database
 * record, a storage key, or a provider response.
 */
export type ErrorCaptureContext = Readonly<{
  boundary: ErrorBoundary;
  /** A stable, low-cardinality name: a route name, an action name, a job name. */
  operationName?: string;
  errorCode?: ErrorCode;
  requestId?: string;
  jobName?: string;
  jobVersion?: number;
}>;

export type ErrorMonitor = Readonly<{
  capture: (error: unknown, context: ErrorCaptureContext) => void;
  flush: (timeoutMs: number) => Promise<void>;
  shutdown: () => Promise<void>;
}>;

/**
 * The monitor when error monitoring is off, misconfigured, or failed to start.
 *
 * It is a real object rather than an `undefined` every call site has to check,
 * because the alternative is a conditional at every boundary and one of them will
 * eventually be missing.
 */
export const NOOP_ERROR_MONITOR: ErrorMonitor = {
  capture: () => undefined,
  flush: async () => undefined,
  shutdown: async () => undefined,
};

/**
 * The error codes that are ordinary traffic rather than defects.
 *
 * A refused request is a working application: a client sent something invalid, was
 * not signed in, lacked a capability, asked for something that is not there,
 * conflicted with another writer, or went too fast. Reporting those to an
 * error-monitoring provider would bury the failures that actually need a human
 * under the ones that need nobody.
 *
 * `DEPENDENCY_UNAVAILABLE` is deliberately *not* on this list. It means a
 * capability the request genuinely needed could not be reached, which is an
 * operational failure worth a report even though it is not a defect in the code.
 */
export const EXPECTED_ERROR_CODES = [
  ERROR_CODE.VALIDATION_FAILED,
  ERROR_CODE.UNAUTHENTICATED,
  ERROR_CODE.FORBIDDEN,
  ERROR_CODE.NOT_FOUND,
  ERROR_CODE.CONFLICT,
  ERROR_CODE.RATE_LIMITED,
] as const satisfies readonly ErrorCode[];

const expectedErrorCodes = new Set<string>(EXPECTED_ERROR_CODES);

/**
 * Whether a failure is worth reporting to an error-monitoring provider.
 *
 * The single decision point. It is deliberately not `isExpectedApplicationError`:
 * that helper answers "should this be logged as a warning rather than an error",
 * which is a similar but not identical question — it treats every non-internal
 * application error as expected, including `DEPENDENCY_UNAVAILABLE`.
 */
export function isReportableError(error: unknown): boolean {
  return !(
    error instanceof ApplicationError && expectedErrorCodes.has(error.code)
  );
}
