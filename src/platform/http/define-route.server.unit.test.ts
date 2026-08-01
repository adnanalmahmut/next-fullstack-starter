import { NextRequest } from "next/server";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import * as z from "zod";

import type { Actor } from "@/platform/auth/authorization/actor";
import type { Authorization } from "@/platform/auth/authorization/authorization-mode";
import {
  PERMISSION,
  type Permission,
} from "@/platform/auth/authorization/permission-registry";
import type { NonEmptyPermissions } from "@/platform/auth/authorization/require-permission.server";
import type { StructuredLogger } from "@/platform/observability/create-logger.server";
import { REQUEST_ID_HEADER } from "@/platform/observability/request-id.server";
import {
  ConflictError,
  NotFoundError,
} from "@/shared/errors/application-error";
import { ERROR_CODE } from "@/shared/errors/error-code";

/**
 * Only the Better Auth instance is replaced, so a session and a capability answer
 * can be scripted without a database. Actor normalization, the capability gate,
 * request-id resolution, error normalization, and serialization all run for real,
 * so this suite exercises the wiring the factory depends on rather than a
 * restatement of it.
 */
const getSession = vi.fn();
const userHasPermission = vi.fn();
const logCalls: {
  level: string;
  fields: Record<string, unknown>;
  event: unknown;
}[] = [];

vi.mock("@/platform/auth/auth.server", () => ({
  auth: {
    api: {
      getSession: (options: unknown) => getSession(options),
      userHasPermission: (options: unknown) => userHasPermission(options),
    },
  },
}));

vi.mock("@/platform/observability/logger.server", () => {
  function record(level: string) {
    return (fields: unknown, event: unknown) => {
      logCalls.push({
        level,
        fields: fields as Record<string, unknown>,
        event,
      });
    };
  }

  const recordingLogger = {
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    child: () => recordingLogger,
  } as unknown as StructuredLogger;

  return {
    logger: recordingLogger,
    createContextLogger: () => recordingLogger,
    getRequestLogger: () => recordingLogger,
  };
});

const { defineRoute } = await import("./define-route.server");
const { AUTHORIZATION_MODE } =
  await import("@/platform/auth/authorization/authorization-mode");
const { getCallerHeaders } =
  await import("@/platform/auth/authorization/caller-headers.server");
const { ROUTE_HOOK, IDEMPOTENCY_OUTCOME, RATE_LIMIT_OUTCOME } =
  await import("./route-hooks");
const { ROUTE_LOG_EVENT } = await import("./log-event");

const REQUEST_ID = "0f1c4a0e-1d3f-4d5e-8a7b-9c0d1e2f3a4b";
const SESSION_COOKIE = "better-auth.session_token=token-value";

const signedInActor: Actor = {
  userId: "user-1",
  sessionId: "session-1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  roles: ["admin"],
};

function signIn(): void {
  getSession.mockResolvedValue({
    session: { id: signedInActor.sessionId, userId: signedInActor.userId },
    user: {
      id: signedInActor.userId,
      name: signedInActor.name,
      email: signedInActor.email,
      role: "admin",
    },
  });
}

type RequestOptions = {
  method?: string;
  url?: string;
  body?: string;
  requestId?: string | null;
  headers?: Record<string, string>;
};

function buildRequest({
  method = "GET",
  url = "http://localhost/api/v1/probe",
  body,
  requestId = REQUEST_ID,
  headers = {},
}: RequestOptions = {}): NextRequest {
  return new NextRequest(url, {
    method,
    ...(body === undefined ? {} : { body }),
    headers: {
      cookie: SESSION_COOKIE,
      ...(requestId === null ? {} : { [REQUEST_ID_HEADER]: requestId }),
      ...headers,
    },
  });
}

function routeContext(params: unknown = {}) {
  return { params: Promise.resolve(params) };
}

async function readBody(response: Response): Promise<unknown> {
  return response.json();
}

function eventsOf(event: string) {
  return logCalls.filter((call) => call.event === event);
}

beforeEach(() => {
  getSession.mockReset();
  userHasPermission.mockReset();
  getSession.mockResolvedValue(null);
  userHasPermission.mockResolvedValue({ success: false });
  logCalls.length = 0;
});

describe("input typing", () => {
  it("infers each declared part from its own schema", () => {
    defineRoute({
      name: "probe.typing.declared",
      input: {
        params: z.object({ userId: z.string() }),
        query: z.object({ limit: z.coerce.number() }),
        body: z.object({ role: z.string() }),
      },
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: ({ params, query, body }) => {
        expectTypeOf(params).toEqualTypeOf<{ userId: string }>();
        expectTypeOf(query).toEqualTypeOf<{ limit: number }>();
        expectTypeOf(body).toEqualTypeOf<{ role: string }>();

        return null;
      },
    });
  });

  it("types an undeclared part as undefined", () => {
    defineRoute({
      name: "probe.typing.undeclared",
      input: { query: z.object({ limit: z.coerce.number() }) },
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ params, query, body }) => {
        expectTypeOf(params).toEqualTypeOf<undefined>();
        expectTypeOf(query).toEqualTypeOf<{ limit: number }>();
        expectTypeOf(body).toEqualTypeOf<undefined>();

        return null;
      },
    });
  });

  it("uses the schema output, so a transform is already applied", () => {
    defineRoute({
      name: "probe.typing.transform",
      input: {
        query: z.object({ tags: z.string().transform((tags) => tags.length) }),
      },
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ query }) => {
        expectTypeOf(query).toEqualTypeOf<{ tags: number }>();

        return null;
      },
    });
  });

  it("resolves the actor type from the declared mode", () => {
    defineRoute({
      name: "probe.typing.public-actor",
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ actor, requestId }) => {
        expectTypeOf(actor).toEqualTypeOf<null>();
        expectTypeOf(requestId).toEqualTypeOf<string>();

        return null;
      },
    });

    for (const authorization of [
      { mode: AUTHORIZATION_MODE.ACTOR },
      {
        mode: AUTHORIZATION_MODE.PERMISSION,
        permission: PERMISSION.IDENTITY_USER_LIST,
      },
    ] as const) {
      defineRoute({
        name: "probe.typing.protected-actor",
        authorization,
        execute: ({ actor }) => {
          expectTypeOf(actor).toEqualTypeOf<Actor>();

          return null;
        },
      });
    }
  });

  it("infers the output from the use case", () => {
    const handler = defineRoute({
      name: "probe.typing.output",
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => ({ total: 1 }),
      hooks: {
        afterSuccess: [
          ({ output }) => {
            expectTypeOf(output).toEqualTypeOf<{ total: number }>();
          },
        ],
      },
    });

    expectTypeOf(handler).parameter(0).toEqualTypeOf<NextRequest>();
    expectTypeOf(handler).returns.toEqualTypeOf<Promise<Response>>();
  });

  it("refuses an empty permission list on a multi-permission mode", () => {
    // An empty list would silently mean "no requirement", so it must not be a
    // usable authorization. The assertion is on assignability rather than on a
    // suppressed compiler error, so it states the rule instead of hiding it.
    expectTypeOf<readonly []>().not.toExtend<NonEmptyPermissions>();
    expectTypeOf<readonly [Permission]>().toExtend<NonEmptyPermissions>();
    expectTypeOf<
      readonly [Permission, Permission]
    >().toExtend<NonEmptyPermissions>();

    expectTypeOf<{
      mode: typeof AUTHORIZATION_MODE.ANY_PERMISSION;
      permissions: readonly [];
    }>().not.toExtend<Authorization>();
    expectTypeOf<{
      mode: typeof AUTHORIZATION_MODE.ALL_PERMISSIONS;
      permissions: readonly [];
    }>().not.toExtend<Authorization>();

    expectTypeOf<{
      mode: typeof AUTHORIZATION_MODE.ANY_PERMISSION;
      permissions: readonly [Permission];
    }>().toExtend<Authorization>();
  });
});

describe("validation", () => {
  it("validates the three parts independently", async () => {
    const handler = defineRoute({
      name: "probe.validation.parts",
      input: {
        params: z.object({ userId: z.string().min(1) }),
        query: z.object({ limit: z.coerce.number().int().max(50) }),
        body: z.object({ role: z.string() }),
      },
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ params, query, body }) => ({ params, query, body }),
    });

    const response = await handler(
      buildRequest({
        method: "POST",
        url: "http://localhost/api/v1/probe?limit=10",
        body: JSON.stringify({ role: "admin" }),
      }),
      routeContext({ userId: "user-2" }),
    );

    expect(response.status).toBe(200);
    expect(await readBody(response)).toEqual({
      data: {
        params: { userId: "user-2" },
        query: { limit: 10 },
        body: { role: "admin" },
      },
    });
  });

  it("applies an async refinement and a transform", async () => {
    const handler = defineRoute({
      name: "probe.validation.async",
      input: {
        query: z.object({
          slug: z
            .string()
            .refine(async (value) => Promise.resolve(value !== "taken"))
            .transform((value) => value.toUpperCase()),
        }),
      },
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ query }) => query,
    });

    expect(
      await readBody(
        await handler(
          buildRequest({ url: "http://localhost/api/v1/probe?slug=free" }),
          routeContext(),
        ),
      ),
    ).toEqual({ data: { slug: "FREE" } });

    const refused = await handler(
      buildRequest({ url: "http://localhost/api/v1/probe?slug=taken" }),
      routeContext(),
    );

    expect(refused.status).toBe(400);
    expect(await readBody(refused)).toEqual({
      error: { code: ERROR_CODE.VALIDATION_FAILED },
    });
  });

  it.each([
    {
      name: "invalid params",
      params: { userId: "" },
      url: "http://localhost/api/v1/probe?limit=10",
      body: JSON.stringify({ role: "admin" }),
    },
    {
      name: "an invalid query",
      params: { userId: "user-2" },
      url: "http://localhost/api/v1/probe?limit=9999",
      body: JSON.stringify({ role: "admin" }),
    },
    {
      name: "an invalid body",
      params: { userId: "user-2" },
      url: "http://localhost/api/v1/probe?limit=10",
      body: JSON.stringify({ role: 7 }),
    },
    {
      name: "malformed JSON",
      params: { userId: "user-2" },
      url: "http://localhost/api/v1/probe?limit=10",
      body: "{not json",
    },
  ])("refuses $name with VALIDATION_FAILED", async ({ params, url, body }) => {
    const executed = vi.fn();
    const handler = defineRoute({
      name: "probe.validation.refusal",
      input: {
        params: z.object({ userId: z.string().min(1) }),
        query: z.object({ limit: z.coerce.number().int().max(50) }),
        body: z.object({ role: z.string() }),
      },
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: executed,
    });

    const response = await handler(
      buildRequest({ method: "POST", url, body }),
      routeContext(params),
    );

    expect(response.status).toBe(400);
    expect(await readBody(response)).toEqual({
      error: { code: ERROR_CODE.VALIDATION_FAILED },
    });
    expect(executed).not.toHaveBeenCalled();
  });

  it("discloses no issue, field name, or supplied value", async () => {
    const handler = defineRoute({
      name: "probe.validation.opaque",
      input: { body: z.object({ secretField: z.string().min(20) }) },
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => null,
    });

    const response = await handler(
      buildRequest({
        method: "POST",
        body: JSON.stringify({ secretField: "hunter2" }),
      }),
      routeContext(),
    );
    const text = await response.text();

    expect(text).toBe(JSON.stringify({ error: { code: "VALIDATION_FAILED" } }));
    expect(text).not.toContain("secretField");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("issues");
  });

  it("keeps a repeated query key instead of accepting one of its values", async () => {
    const seen = vi.fn();
    const handler = defineRoute({
      name: "probe.validation.repeated",
      input: { query: z.object({ limit: z.coerce.number() }) },
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ query }) => {
        seen(query);

        return query;
      },
    });

    const response = await handler(
      buildRequest({ url: "http://localhost/api/v1/probe?limit=1&limit=50" }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    expect(seen).not.toHaveBeenCalled();
  });

  it("reads no body when no body schema is declared", async () => {
    const handler = defineRoute({
      name: "probe.validation.no-body",
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => ({ ok: true }),
    });

    const request = buildRequest({ method: "POST", body: "{not json" });
    const response = await handler(request, routeContext());

    expect(response.status).toBe(200);
    expect(request.bodyUsed).toBe(false);
  });
});

describe("authorization", () => {
  it("runs a public route without consulting a session", async () => {
    const handler = defineRoute({
      name: "probe.auth.public",
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ actor }) => ({ actor }),
    });

    const response = await handler(buildRequest(), routeContext());

    expect(await readBody(response)).toEqual({ data: { actor: null } });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller with 401", async () => {
    const executed = vi.fn();
    const handler = defineRoute({
      name: "probe.auth.actor",
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: executed,
    });

    const response = await handler(buildRequest(), routeContext());

    expect(response.status).toBe(401);
    expect(await readBody(response)).toEqual({
      error: { code: ERROR_CODE.UNAUTHENTICATED },
    });
    expect(executed).not.toHaveBeenCalled();
  });

  it("admits an authenticated caller on an actor route", async () => {
    signIn();

    const handler = defineRoute({
      name: "probe.auth.actor-granted",
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: ({ actor }) => ({ userId: actor.userId }),
    });

    expect(
      await readBody(await handler(buildRequest(), routeContext())),
    ).toEqual({ data: { userId: "user-1" } });
    expect(userHasPermission).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a single permission",
      authorization: {
        mode: AUTHORIZATION_MODE.PERMISSION,
        permission: PERMISSION.IDENTITY_USER_LIST,
      },
    },
    {
      name: "any permission",
      authorization: {
        mode: AUTHORIZATION_MODE.ANY_PERMISSION,
        permissions: [
          PERMISSION.IDENTITY_USER_LIST,
          PERMISSION.IDENTITY_AUDIT_READ,
        ],
      },
    },
    {
      name: "all permissions",
      authorization: {
        mode: AUTHORIZATION_MODE.ALL_PERMISSIONS,
        permissions: [
          PERMISSION.IDENTITY_USER_LIST,
          PERMISSION.IDENTITY_AUDIT_READ,
        ],
      },
    },
  ] as const)(
    "refuses $name with 403 before the use case",
    async ({ authorization }) => {
      signIn();

      const executed = vi.fn();
      const handler = defineRoute({
        name: "probe.auth.permission",
        authorization,
        execute: executed,
      });

      const response = await handler(buildRequest(), routeContext());

      expect(response.status).toBe(403);
      expect(await readBody(response)).toEqual({
        error: { code: ERROR_CODE.FORBIDDEN },
      });
      expect(executed).not.toHaveBeenCalled();
    },
  );

  it("reaches the use case once every capability is granted", async () => {
    signIn();
    userHasPermission.mockResolvedValue({ success: true });

    const handler = defineRoute({
      name: "probe.auth.granted",
      authorization: {
        mode: AUTHORIZATION_MODE.ALL_PERMISSIONS,
        permissions: [
          PERMISSION.IDENTITY_USER_LIST,
          PERMISSION.IDENTITY_AUDIT_READ,
        ],
      },
      execute: ({ actor }) => ({ userId: actor.userId }),
    });

    expect(
      await readBody(await handler(buildRequest(), routeContext())),
    ).toEqual({ data: { userId: "user-1" } });
  });

  it("authorizes before it validates nothing it should not, and never after the use case", async () => {
    signIn();

    const order: string[] = [];
    const handler = defineRoute({
      name: "probe.auth.order",
      input: { params: z.object({ userId: z.string().min(1) }) },
      authorization: {
        mode: AUTHORIZATION_MODE.PERMISSION,
        permission: PERMISSION.IDENTITY_USER_READ,
      },
      execute: () => {
        order.push("execute");

        return null;
      },
    });

    userHasPermission.mockImplementation(() => {
      order.push("authorize");

      return { success: false };
    });

    const response = await handler(
      buildRequest(),
      routeContext({ userId: "user-2" }),
    );

    expect(response.status).toBe(403);
    expect(order).toEqual(["authorize"]);
  });

  it("hands the use case no transport", async () => {
    signIn();

    const handler = defineRoute({
      name: "probe.auth.no-transport",
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: (context) => ({ keys: Object.keys(context).sort() }),
    });

    expect(
      await readBody(await handler(buildRequest(), routeContext())),
    ).toEqual({
      data: {
        keys: ["actor", "body", "params", "query", "requestId", "routeName"],
      },
    });
  });

  it("opens the caller header scope for a delegating service", async () => {
    signIn();

    const handler = defineRoute({
      name: "probe.auth.caller-headers",
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: () => ({ cookie: getCallerHeaders()?.get("cookie") ?? null }),
    });

    expect(
      await readBody(await handler(buildRequest(), routeContext())),
    ).toEqual({ data: { cookie: SESSION_COOKIE } });
  });

  it("closes the caller header scope once the request is answered", async () => {
    const handler = defineRoute({
      name: "probe.auth.scope-closed",
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => null,
    });

    await handler(buildRequest(), routeContext());

    expect(getCallerHeaders()).toBeUndefined();
  });
});

describe("response contract", () => {
  it("answers a static success status declared by the route", async () => {
    const handler = defineRoute({
      name: "probe.response.created",
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      successStatus: 201,
      execute: () => ({ id: "entity-1" }),
    });

    expect((await handler(buildRequest(), routeContext())).status).toBe(201);
  });

  it("answers a null envelope rather than 204 when there is no payload", async () => {
    const handler = defineRoute({
      name: "probe.response.empty",
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => null,
    });

    const response = await handler(buildRequest(), routeContext());

    expect(response.status).toBe(200);
    expect(await readBody(response)).toEqual({ data: null });
  });

  it.each([
    { error: new NotFoundError("absent"), status: 404, code: "NOT_FOUND" },
    { error: new ConflictError("conflict"), status: 409, code: "CONFLICT" },
  ])("maps a known $code to $status", async ({ error, status, code }) => {
    const handler = defineRoute({
      name: "probe.response.known-error",
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => {
        throw error;
      },
    });

    const response = await handler(buildRequest(), routeContext());

    expect(response.status).toBe(status);
    expect(await readBody(response)).toEqual({ error: { code } });
  });

  it("hides an unexpected failure behind INTERNAL_ERROR and 500", async () => {
    const handler = defineRoute({
      name: "probe.response.unknown-error",
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => {
        throw new TypeError(
          'relation "user" does not exist at /srv/app/prisma.ts',
        );
      },
    });

    const response = await handler(buildRequest(), routeContext());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).toBe(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }));
    expect(text).not.toContain("relation");
    expect(text).not.toContain("/srv/app");
    expect(text).not.toContain("stack");
  });

  it("returns the propagated request id on every outcome", async () => {
    const succeeding = defineRoute({
      name: "probe.response.request-id-success",
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ requestId }) => ({ requestId }),
    });
    const failing = defineRoute({
      name: "probe.response.request-id-failure",
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: () => null,
    });

    const success = await succeeding(buildRequest(), routeContext());
    const failure = await failing(buildRequest(), routeContext());

    expect(success.headers.get(REQUEST_ID_HEADER)).toBe(REQUEST_ID);
    expect(await readBody(success)).toEqual({
      data: { requestId: REQUEST_ID },
    });
    expect(failure.headers.get(REQUEST_ID_HEADER)).toBe(REQUEST_ID);
  });

  it("creates a request id when the caller supplies none or a bad one", async () => {
    const handler = defineRoute({
      name: "probe.response.request-id-created",
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ requestId }) => ({ requestId }),
    });

    for (const requestId of [null, "not-a-uuid"]) {
      const response = await handler(
        buildRequest({ requestId }),
        routeContext(),
      );
      const header = response.headers.get(REQUEST_ID_HEADER);

      expect(header).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(header).not.toBe("not-a-uuid");
      expect(await readBody(response)).toEqual({ data: { requestId: header } });
    }
  });
});

describe("hooks", () => {
  function orderedRoute(order: string[]) {
    return defineRoute({
      name: "probe.hooks.order",
      input: { query: z.object({ limit: z.coerce.number() }) },
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: () => {
        order.push("execute");

        return { done: true };
      },
      hooks: {
        rateLimit: [
          () => {
            order.push(ROUTE_HOOK.RATE_LIMIT);

            return RATE_LIMIT_OUTCOME.ALLOWED;
          },
        ],
        idempotency: [
          () => {
            order.push(ROUTE_HOOK.IDEMPOTENCY);

            return { outcome: IDEMPOTENCY_OUTCOME.PROCEED };
          },
        ],
        beforeExecute: [
          () => {
            order.push(ROUTE_HOOK.BEFORE_EXECUTE);
          },
        ],
        afterSuccess: [
          () => {
            order.push(ROUTE_HOOK.AFTER_SUCCESS);
          },
        ],
        audit: [
          () => {
            order.push(ROUTE_HOOK.AUDIT);
          },
        ],
        afterFailure: [
          () => {
            order.push(ROUTE_HOOK.AFTER_FAILURE);
          },
        ],
      },
    });
  }

  it("runs the hooks in the declared order around the use case", async () => {
    signIn();

    const order: string[] = [];

    await orderedRoute(order)(
      buildRequest({ url: "http://localhost/api/v1/probe?limit=1" }),
      routeContext(),
    );

    expect(order).toEqual([
      "rateLimit",
      "idempotency",
      "beforeExecute",
      "execute",
      "afterSuccess",
      "audit",
    ]);
  });

  it("runs the rate limit before validation and authentication", async () => {
    const order: string[] = [];

    await orderedRoute(order)(
      buildRequest({ url: "http://localhost/api/v1/probe?limit=nope" }),
      routeContext(),
    );

    expect(order).toEqual(["rateLimit", "afterFailure"]);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("refuses a rate-limited caller with RATE_LIMITED and 429", async () => {
    const executed = vi.fn();
    const handler = defineRoute({
      name: "probe.hooks.rate-limited",
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: executed,
      hooks: { rateLimit: [() => RATE_LIMIT_OUTCOME.REFUSED] },
    });

    const response = await handler(buildRequest(), routeContext());

    expect(response.status).toBe(429);
    expect(await readBody(response)).toEqual({
      error: { code: ERROR_CODE.RATE_LIMITED },
    });
    expect(executed).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("gives the rate-limit hook request metadata and nothing parsed", async () => {
    const seen = vi.fn(() => RATE_LIMIT_OUTCOME.ALLOWED);
    const handler = defineRoute({
      name: "probe.hooks.rate-limit-context",
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => null,
      hooks: { rateLimit: [seen] },
    });

    await handler(buildRequest({ method: "POST" }), routeContext());

    expect(seen).toHaveBeenCalledExactlyOnceWith({
      routeName: "probe.hooks.rate-limit-context",
      method: "POST",
      requestId: REQUEST_ID,
      headers: expect.any(Headers),
    });
  });

  it("replays a typed result without running the use case", async () => {
    signIn();
    userHasPermission.mockResolvedValue({ success: true });

    const executed = vi.fn();
    const audited = vi.fn();
    const handler = defineRoute({
      name: "probe.hooks.replay",
      authorization: {
        mode: AUTHORIZATION_MODE.PERMISSION,
        permission: PERMISSION.IDENTITY_USER_SET_ROLE,
      },
      successStatus: 201,
      execute: executed as () => { id: string },
      hooks: {
        idempotency: [
          () => ({
            outcome: IDEMPOTENCY_OUTCOME.REPLAY,
            output: { id: "entity-1" },
          }),
        ],
        audit: [audited],
      },
    });

    const response = await handler(buildRequest(), routeContext());

    expect(response.status).toBe(201);
    expect(await readBody(response)).toEqual({ data: { id: "entity-1" } });
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(REQUEST_ID);
    expect(executed).not.toHaveBeenCalled();
    expect(audited).not.toHaveBeenCalled();
    expect(eventsOf(ROUTE_LOG_EVENT.REPLAYED)).toHaveLength(1);
    expect(eventsOf(ROUTE_LOG_EVENT.REPLAYED)[0]?.fields).toMatchObject({
      replayed: true,
      statusCode: 201,
    });
  });

  it("answers an idempotency conflict with CONFLICT and 409", async () => {
    signIn();

    const executed = vi.fn();
    const handler = defineRoute({
      name: "probe.hooks.conflict",
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: executed,
      hooks: {
        idempotency: [() => ({ outcome: IDEMPOTENCY_OUTCOME.CONFLICT })],
      },
    });

    const response = await handler(buildRequest(), routeContext());

    expect(response.status).toBe(409);
    expect(await readBody(response)).toEqual({
      error: { code: ERROR_CODE.CONFLICT },
    });
    expect(executed).not.toHaveBeenCalled();
  });

  it("runs idempotency only after authorization", async () => {
    signIn();

    const idempotency = vi.fn(() => ({
      outcome: IDEMPOTENCY_OUTCOME.REPLAY as typeof IDEMPOTENCY_OUTCOME.REPLAY,
      output: null,
    }));
    const handler = defineRoute({
      name: "probe.hooks.replay-after-authorization",
      authorization: {
        mode: AUTHORIZATION_MODE.PERMISSION,
        permission: PERMISSION.IDENTITY_USER_SET_ROLE,
      },
      execute: () => null,
      hooks: { idempotency: [idempotency] },
    });

    const response = await handler(buildRequest(), routeContext());

    expect(response.status).toBe(403);
    expect(idempotency).not.toHaveBeenCalled();
  });

  it("stops the use case when a beforeExecute hook throws", async () => {
    signIn();

    const executed = vi.fn();
    const handler = defineRoute({
      name: "probe.hooks.gate",
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: executed,
      hooks: {
        beforeExecute: [
          () => {
            throw new ConflictError("the resource is busy");
          },
        ],
      },
    });

    const response = await handler(buildRequest(), routeContext());

    expect(response.status).toBe(409);
    expect(executed).not.toHaveBeenCalled();
  });

  it("hands afterFailure a public error and never the raw one", async () => {
    const seen = vi.fn();
    const handler = defineRoute({
      name: "probe.hooks.failure-context",
      input: { query: z.object({ limit: z.coerce.number() }) },
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => {
        throw new TypeError("connection string postgres://user:secret@db");
      },
      hooks: { afterFailure: [seen] },
    });

    await handler(
      buildRequest({ url: "http://localhost/api/v1/probe?limit=1" }),
      routeContext(),
    );

    expect(seen).toHaveBeenCalledExactlyOnceWith({
      routeName: "probe.hooks.failure-context",
      requestId: REQUEST_ID,
      input: { params: undefined, query: { limit: 1 }, body: undefined },
      actor: null,
      error: { code: ERROR_CODE.INTERNAL_ERROR },
    });
    expect(JSON.stringify(seen.mock.calls)).not.toContain("secret");
  });

  it("reports no input to afterFailure when validation is what failed", async () => {
    const seen = vi.fn();
    const handler = defineRoute({
      name: "probe.hooks.failure-no-input",
      input: { query: z.object({ limit: z.coerce.number() }) },
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => null,
      hooks: { afterFailure: [seen] },
    });

    await handler(
      buildRequest({ url: "http://localhost/api/v1/probe?limit=nope" }),
      routeContext(),
    );

    expect(seen.mock.calls[0]?.[0]).toMatchObject({ input: null, actor: null });
  });

  it("keeps a completed mutation successful when an observer throws", async () => {
    signIn();

    const later = vi.fn();
    const handler = defineRoute({
      name: "probe.hooks.observer-isolation",
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: () => ({ committed: true }),
      hooks: {
        afterSuccess: [
          () => {
            throw new Error("audit sink is unreachable at 10.0.0.5");
          },
          later,
        ],
        audit: [
          () => {
            throw new Error("second sink is unreachable");
          },
        ],
      },
    });

    const response = await handler(buildRequest(), routeContext());

    expect(response.status).toBe(200);
    expect(await readBody(response)).toEqual({ data: { committed: true } });
    expect(later).toHaveBeenCalledOnce();

    const failures = eventsOf(ROUTE_LOG_EVENT.HOOK_FAILED);

    expect(failures.map((call) => call.fields.hookName)).toEqual([
      ROUTE_HOOK.AFTER_SUCCESS,
      ROUTE_HOOK.AUDIT,
    ]);
    expect(JSON.stringify(failures)).not.toContain("10.0.0.5");
  });
});

describe("logging", () => {
  it("logs a start and a completion carrying only allowlisted fields", async () => {
    signIn();
    userHasPermission.mockResolvedValue({ success: true });

    const handler = defineRoute({
      name: "probe.logging.success",
      input: { body: z.object({ role: z.string() }) },
      authorization: {
        mode: AUTHORIZATION_MODE.PERMISSION,
        permission: PERMISSION.IDENTITY_USER_SET_ROLE,
      },
      execute: () => ({ email: "target@example.com" }),
    });

    await handler(
      buildRequest({
        method: "PATCH",
        body: JSON.stringify({ role: "admin" }),
      }),
      routeContext(),
    );

    const [started] = eventsOf(ROUTE_LOG_EVENT.STARTED);
    const [succeeded] = eventsOf(ROUTE_LOG_EVENT.SUCCEEDED);

    expect(started?.fields).toEqual({
      routeName: "probe.logging.success",
      method: "PATCH",
      requestId: REQUEST_ID,
    });
    expect(succeeded?.level).toBe("info");
    expect(Object.keys(succeeded?.fields ?? {}).sort()).toEqual([
      "actorUserId",
      "durationMs",
      "method",
      "requestId",
      "routeName",
      "statusCode",
    ]);
    expect(succeeded?.fields).toMatchObject({
      actorUserId: "user-1",
      statusCode: 200,
    });
  });

  it("never logs a payload, an identity, a URL, or a raw error", async () => {
    signIn();

    const handler = defineRoute({
      name: "probe.logging.leakage",
      input: {
        query: z.object({ search: z.string() }),
        body: z.object({ password: z.string() }),
      },
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: () => {
        throw new Error("postgres://user:hunter2@db/app");
      },
    });

    await handler(
      buildRequest({
        method: "POST",
        url: "http://localhost/api/v1/probe?search=ada@example.com",
        body: JSON.stringify({ password: "hunter2" }),
        headers: { authorization: "Bearer secret-token" },
      }),
      routeContext(),
    );

    const serialized = JSON.stringify(logCalls);

    for (const forbidden of [
      "hunter2",
      "ada@example.com",
      "Ada Lovelace",
      "Bearer",
      "secret-token",
      "better-auth.session_token",
      "postgres://",
      "http://localhost",
      "stack",
      "issues",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("warns on a refusal and errors on an unexpected failure", async () => {
    const refusing = defineRoute({
      name: "probe.logging.refusal",
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: () => null,
    });
    const failing = defineRoute({
      name: "probe.logging.failure",
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => {
        throw new TypeError("boom");
      },
    });

    await refusing(buildRequest(), routeContext());
    await failing(buildRequest(), routeContext());

    const [refused, failed] = eventsOf(ROUTE_LOG_EVENT.FAILED);

    expect(refused?.level).toBe("warn");
    expect(refused?.fields).toMatchObject({
      statusCode: 401,
      errorCode: ERROR_CODE.UNAUTHENTICATED,
    });
    expect(failed?.level).toBe("error");
    expect(failed?.fields).toMatchObject({
      statusCode: 500,
      errorCode: ERROR_CODE.INTERNAL_ERROR,
    });
  });

  it("attributes a refusal to the caller once one is known", async () => {
    signIn();

    const handler = defineRoute({
      name: "probe.logging.attributed",
      authorization: {
        mode: AUTHORIZATION_MODE.PERMISSION,
        permission: PERMISSION.IDENTITY_USER_LIST,
      },
      execute: () => null,
    });

    await handler(buildRequest(), routeContext());

    expect(eventsOf(ROUTE_LOG_EVENT.FAILED)[0]?.fields).toMatchObject({
      actorUserId: "user-1",
      errorCode: ERROR_CODE.FORBIDDEN,
      statusCode: 403,
    });
  });
});
