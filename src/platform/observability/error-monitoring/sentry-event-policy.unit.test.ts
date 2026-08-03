import { describe, expect, it } from "vitest";

import {
  MAX_SENTRY_STACK_FRAMES,
  MAX_SENTRY_TAG_LENGTH,
  REDACTED_ERROR_VALUE,
  sanitizeSentryEvent,
  SENTRY_TAG_NAMES,
  type IncomingSentryEvent,
} from "./sentry-event-policy";

/**
 * An event shaped the way the Sentry Node SDK builds one, including every field
 * this policy has to drop. It is deliberately full of things that must never leave
 * the deployment.
 */
function incomingEvent(): IncomingSentryEvent & Record<string, unknown> {
  return {
    event_id: "abc123",
    timestamp: 1_754_000_000,
    platform: "node",
    level: "error",
    environment: "production",
    release: "1.2.3",
    sdk: { name: "sentry.javascript.node", version: "10.69.0" },
    server_name: "web-7f9c4d5b6-xk2mp",
    transaction: "POST /api/v1/admin/users",
    modules: { next: "16.2.12", prisma: "7.9.1" },
    tags: {
      boundary: "route",
      process_type: "web",
      operation_name: "identity.user.role.set",
      error_code: "INTERNAL_ERROR",
      request_id: "123e4567-e89b-42d3-a456-426614174000",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      job_name: "mail.send",
      job_version: 2,
      customer_email: "person@example.com",
    },
    user: { id: "user-1", email: "person@example.com", ip_address: "10.0.0.7" },
    request: {
      url: "https://app.example.com/api/v1/admin/users?token=secret",
      method: "POST",
      headers: { cookie: "session=secret", authorization: "Bearer secret" },
      data: { password: "hunter2" },
    },
    breadcrumbs: [{ message: "SELECT * FROM user WHERE email = 'a@b.c'" }],
    extra: { payload: { cardNumber: "4111111111111111" } },
    contexts: { runtime: { name: "node" }, os: { name: "linux" } },
    exception: {
      values: [
        {
          type: "PrismaClientKnownRequestError",
          value:
            "Unique constraint failed on the fields: (`email`) for person@example.com",
          mechanism: { type: "generic", handled: true },
          stacktrace: {
            frames: [
              {
                filename: "/app/src/platform/http/define-route.server.ts",
                function: "runRoute",
                module: "define-route.server",
                lineno: 452,
                colno: 26,
                in_app: true,
                abs_path: "/app/src/platform/http/define-route.server.ts",
                context_line:
                  "const output = await definition.execute(context)",
                pre_context: ["// secret comment"],
                post_context: ["// more"],
                vars: { password: "hunter2", token: "secret-token" },
              },
            ],
          },
        },
      ],
    },
  };
}

describe("what survives the allowlist", () => {
  it("keeps only the named top-level fields", () => {
    const sanitized = sanitizeSentryEvent(incomingEvent());

    expect(Object.keys(sanitized).sort()).toEqual([
      "environment",
      "event_id",
      "exception",
      "level",
      "platform",
      "release",
      "sdk",
      "tags",
      "timestamp",
    ]);
  });

  it("keeps the exception type, because a class name is safe identity", () => {
    const sanitized = sanitizeSentryEvent(incomingEvent());

    expect(sanitized.exception?.values[0]?.type).toBe(
      "PrismaClientKnownRequestError",
    );
  });

  it("keeps the frame location and nothing else", () => {
    const sanitized = sanitizeSentryEvent(incomingEvent());
    const frame = sanitized.exception?.values[0]?.stacktrace?.frames[0];

    expect(Object.keys(frame ?? {}).sort()).toEqual([
      "colno",
      "filename",
      "function",
      "in_app",
      "lineno",
      "module",
    ]);
  });

  it("keeps only the allowlisted tags", () => {
    const sanitized = sanitizeSentryEvent(incomingEvent());

    expect(Object.keys(sanitized.tags ?? {}).sort()).toEqual(
      [...SENTRY_TAG_NAMES].sort(),
    );
    expect(sanitized.tags?.job_version).toBe("2");
  });
});

describe("what never leaves the deployment", () => {
  it("drops every field carrying request, identity, or payload data", () => {
    const sanitized = sanitizeSentryEvent(incomingEvent()) as Record<
      string,
      unknown
    >;

    for (const dropped of [
      "server_name",
      "transaction",
      "modules",
      "user",
      "request",
      "breadcrumbs",
      "extra",
      "contexts",
      "spans",
      "measurements",
    ]) {
      expect(sanitized, dropped).not.toHaveProperty(dropped);
    }
  });

  it("leaves no trace of a secret anywhere in the serialized event", () => {
    const serialized = JSON.stringify(sanitizeSentryEvent(incomingEvent()));

    for (const secret of [
      "person@example.com",
      "hunter2",
      "secret-token",
      "session=secret",
      "Bearer secret",
      "4111111111111111",
      "SELECT * FROM user",
      "10.0.0.7",
      "web-7f9c4d5b6-xk2mp",
      "customer_email",
    ]) {
      expect(serialized, secret).not.toContain(secret);
    }
  });

  it("replaces the exception message with the stable error code", () => {
    const sanitized = sanitizeSentryEvent(incomingEvent());

    expect(sanitized.exception?.values[0]?.value).toBe("INTERNAL_ERROR");
  });

  it("falls back to a fixed value when no error code was set", () => {
    const event = incomingEvent();

    event.tags = { boundary: "job" };

    // Truncating an unknown message would still be sending an unknown message,
    // only less of it.
    expect(sanitizeSentryEvent(event).exception?.values[0]?.value).toBe(
      REDACTED_ERROR_VALUE,
    );
  });

  it("truncates a tag value that is too long to be an identifier", () => {
    const event = incomingEvent();

    event.tags = { operation_name: "n".repeat(MAX_SENTRY_TAG_LENGTH + 50) };

    expect(sanitizeSentryEvent(event).tags?.operation_name).toHaveLength(
      MAX_SENTRY_TAG_LENGTH,
    );
  });

  it("bounds the stack to its innermost frames", () => {
    const event = incomingEvent();
    const frames = Array.from(
      { length: MAX_SENTRY_STACK_FRAMES + 10 },
      (_, index) => ({ function: `frame${index}`, lineno: index }),
    );

    event.exception = { values: [{ type: "Error", stacktrace: { frames } }] };

    const sanitized = sanitizeSentryEvent(event);
    const kept = sanitized.exception?.values[0]?.stacktrace?.frames ?? [];

    expect(kept).toHaveLength(MAX_SENTRY_STACK_FRAMES);
    // Sentry orders frames outermost-first, so the tail locates the failure.
    expect(kept.at(-1)?.function).toBe(`frame${MAX_SENTRY_STACK_FRAMES + 9}`);
  });
});

describe("tolerating a malformed event", () => {
  it("accepts an event with nothing on it", () => {
    expect(sanitizeSentryEvent({})).toEqual({});
  });

  it("ignores a non-object tag bag and a non-array frame list", () => {
    const sanitized = sanitizeSentryEvent({
      tags: "not-an-object",
      exception: { values: [{ stacktrace: { frames: "not-an-array" } }] },
    });

    expect(sanitized.tags).toBeUndefined();
    expect(sanitized.exception?.values[0]).toEqual({
      value: REDACTED_ERROR_VALUE,
    });
  });

  it("drops a frame that describes no location at all", () => {
    const sanitized = sanitizeSentryEvent({
      exception: {
        values: [{ stacktrace: { frames: [{ vars: { secret: "x" } }] } }],
      },
    });

    expect(sanitized.exception?.values[0]?.stacktrace).toBeUndefined();
  });
});
