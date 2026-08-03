/**
 * What is allowed to leave this application inside an error report.
 *
 * This is the single enforcement point of the redaction policy, and it works by
 * **construction rather than removal**: it builds a new event from an allowlist
 * instead of deleting fields from the one the SDK produced. That direction matters
 * more than it looks. A deny-list has to be updated every time the provider adds a
 * field, and the failure mode of forgetting is that the new field is sent; an
 * allowlist's failure mode is that a new field is dropped, which is the failure
 * this application would rather have.
 *
 * The event shapes below are declared structurally rather than imported from the
 * vendor SDK. That keeps this file pure and testable with no SDK loaded, and it
 * makes the allowlist a contract of this repository rather than a subset of
 * somebody else's type.
 *
 * What is dropped, and why each one is worth naming:
 *
 * - `request` — the URL, the query string, the headers, the cookies, and the body.
 * - `user` — the id, the email address, the username, and the IP address.
 * - `breadcrumbs` — a trail of everything that happened before the failure,
 *   including logged values and HTTP requests.
 * - `extra` and `contexts` — open bags, filled by integrations.
 * - `server_name` — the host name, which the Node SDK fills in by default.
 * - `modules` — the installed dependency graph and its versions.
 * - `transaction`, `spans`, `measurements` — performance data this application
 *   does not send, because tracing belongs to OpenTelemetry.
 * - Every stack-frame field except the location: `vars` (the local variables at
 *   the point of failure — the single richest source of payload in a stack) and
 *   the source-context lines around the frame.
 * - The exception message, replaced by a stable code.
 */

/** The stack-frame fields that describe a location and nothing else. */
export type SanitizedStackFrame = Readonly<{
  filename?: string;
  function?: string;
  module?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}>;

export type SanitizedException = Readonly<{
  /**
   * The error's class name, which this repository already treats as safe
   * identity: the outbox dispatcher logs `error.constructor.name` for the same
   * reason. It is what makes two different failures group separately.
   */
  type?: string;
  /** Always a stable code. Never the original message. */
  value: string;
  stacktrace?: Readonly<{ frames: readonly SanitizedStackFrame[] }>;
}>;

export type SanitizedSentryEvent = Readonly<{
  event_id?: string;
  timestamp?: number;
  platform?: string;
  level?: string;
  environment?: string;
  release?: string;
  sdk?: unknown;
  tags?: Readonly<Record<string, string | number>>;
  exception?: Readonly<{ values: readonly SanitizedException[] }>;
}>;

/** The loose shape an incoming event is read through. */
type IncomingStackFrame = {
  filename?: unknown;
  function?: unknown;
  module?: unknown;
  lineno?: unknown;
  colno?: unknown;
  in_app?: unknown;
};

type IncomingException = {
  type?: unknown;
  stacktrace?: { frames?: unknown };
};

export type IncomingSentryEvent = {
  event_id?: unknown;
  timestamp?: unknown;
  platform?: unknown;
  level?: unknown;
  environment?: unknown;
  release?: unknown;
  sdk?: unknown;
  tags?: unknown;
  exception?: { values?: unknown };
};

/**
 * The value every exception message is replaced with when no stable code applies.
 *
 * A fixed string rather than a truncated message: truncating an unknown message is
 * still sending an unknown message, only less of it.
 */
export const REDACTED_ERROR_VALUE = "unexpected-error";

/**
 * The frames kept from a stack.
 *
 * Bounded because a deep recursion produces thousands, and the innermost ones are
 * the ones that locate the failure. Sentry orders frames outermost-first, so the
 * tail is what is kept.
 */
export const MAX_SENTRY_STACK_FRAMES = 50;

/** The tags an event may carry, and the only ones. */
export const SENTRY_TAG_NAMES = [
  "boundary",
  "process_type",
  "operation_name",
  "error_code",
  "request_id",
  "trace_id",
  "job_name",
  "job_version",
] as const;

export type SentryTagName = (typeof SENTRY_TAG_NAMES)[number];

const allowedTagNames = new Set<string>(SENTRY_TAG_NAMES);

/** The longest a tag value may be, so no tag can carry a payload in disguise. */
export const MAX_SENTRY_TAG_LENGTH = 200;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sanitizeFrame(value: unknown): SanitizedStackFrame | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const frame = value as IncomingStackFrame;

  const filename = optionalString(frame.filename);
  const functionName = optionalString(frame.function);
  const moduleName = optionalString(frame.module);
  const lineno = optionalNumber(frame.lineno);
  const colno = optionalNumber(frame.colno);
  const inApp = optionalBoolean(frame.in_app);

  const sanitized: SanitizedStackFrame = {
    ...(filename === undefined ? {} : { filename }),
    ...(functionName === undefined ? {} : { function: functionName }),
    ...(moduleName === undefined ? {} : { module: moduleName }),
    ...(lineno === undefined ? {} : { lineno }),
    ...(colno === undefined ? {} : { colno }),
    ...(inApp === undefined ? {} : { in_app: inApp }),
  };

  return Object.keys(sanitized).length === 0 ? null : sanitized;
}

function sanitizeException(
  value: unknown,
  errorValue: string,
): SanitizedException {
  const incoming =
    typeof value === "object" && value !== null
      ? (value as IncomingException)
      : {};
  const type = optionalString(incoming.type);
  const rawFrames = incoming.stacktrace?.frames;
  const frames = Array.isArray(rawFrames)
    ? rawFrames
        .slice(-MAX_SENTRY_STACK_FRAMES)
        .map(sanitizeFrame)
        .filter((frame): frame is SanitizedStackFrame => frame !== null)
    : [];

  return {
    ...(type === undefined ? {} : { type }),
    value: errorValue,
    ...(frames.length === 0 ? {} : { stacktrace: { frames } }),
  };
}

function sanitizeTags(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const tags: Record<string, string> = {};

  for (const [name, tagValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!allowedTagNames.has(name)) {
      continue;
    }

    if (typeof tagValue === "string") {
      tags[name] = tagValue.slice(0, MAX_SENTRY_TAG_LENGTH);

      continue;
    }

    if (typeof tagValue === "number" && Number.isFinite(tagValue)) {
      tags[name] = String(tagValue);
    }
  }

  return tags;
}

/**
 * Rebuilds an event from the allowlist.
 *
 * The replacement message is taken from the event's own `error_code` tag when the
 * capturing boundary set one, so the redaction leaves behind a useful identifier
 * rather than only a hole. Deriving it from the event rather than from a closure
 * is what lets this function be the whole policy: it is pure, it needs no capture
 * context, and it can be exercised against a hand-written event in a unit test.
 */
export function sanitizeSentryEvent(
  event: IncomingSentryEvent,
): SanitizedSentryEvent {
  const errorValue =
    typeof event.tags === "object" &&
    event.tags !== null &&
    typeof (event.tags as Record<string, unknown>).error_code === "string"
      ? ((event.tags as Record<string, string>).error_code ??
        REDACTED_ERROR_VALUE)
      : REDACTED_ERROR_VALUE;
  const eventId = optionalString(event.event_id);
  const timestamp = optionalNumber(event.timestamp);
  const platform = optionalString(event.platform);
  const level = optionalString(event.level);
  const environment = optionalString(event.environment);
  const release = optionalString(event.release);
  const tags = sanitizeTags(event.tags);
  const rawValues = event.exception?.values;
  const values = Array.isArray(rawValues)
    ? rawValues.map((value) => sanitizeException(value, errorValue))
    : [];

  return {
    ...(eventId === undefined ? {} : { event_id: eventId }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(platform === undefined ? {} : { platform }),
    ...(level === undefined ? {} : { level }),
    ...(environment === undefined ? {} : { environment }),
    ...(release === undefined ? {} : { release }),
    // SDK metadata identifies the client library, not the application or its
    // users, and the provider needs it to process the event at all.
    ...(event.sdk === undefined ? {} : { sdk: event.sdk }),
    ...(Object.keys(tags).length === 0 ? {} : { tags }),
    ...(values.length === 0 ? {} : { exception: { values } }),
  };
}
