import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import * as z from "zod";

import type { ActionResult } from "@/platform/actions/action-result";
import type { Actor } from "@/platform/auth/authorization/actor";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import type { StructuredLogger } from "@/platform/observability/create-logger.server";
import { runWithRequestContext } from "@/platform/observability/request-context.server";
import {
  ConflictError,
  NotFoundError,
} from "@/shared/errors/application-error";
import { ERROR_CODE } from "@/shared/errors/error-code";

/**
 * Only the two edges of the adapter are replaced: the Better Auth instance, so a
 * session and a capability answer can be scripted without a database, and the
 * Next.js cache APIs. Actor normalization and the capability gate itself run for
 * real, so this suite exercises the wiring the factory depends on rather than a
 * restatement of it.
 */
type PermissionRequest = Readonly<Record<string, readonly string[]>>;

const getSession = vi.fn();
const userHasPermission = vi.fn();
const revalidatePath = vi.fn();
const revalidateTag = vi.fn();
const updateTag = vi.fn();
const logCalls: {
  level: string;
  fields: Record<string, unknown>;
  event: unknown;
}[] = [];

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/platform/auth/auth.server", () => ({
  auth: {
    api: {
      getSession: (options: unknown) => getSession(options),
      userHasPermission: (options: unknown) => userHasPermission(options),
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string, type?: string) => revalidatePath(path, type),
  revalidateTag: (tag: string, profile: unknown) => revalidateTag(tag, profile),
  updateTag: (tag: string) => updateTag(tag),
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

const { defineAction } = await import("./define-action.server");
const { AUTHORIZATION_MODE } = await import("./action-definition");
const { ACTION_HOOK } = await import("./action-hooks");
const { SERVER_ACTION_LOG_EVENT } = await import("./log-event");
const { createCacheIdentity } = await import("@/platform/cache/cache-identity");
const { TAG_STRATEGY } = await import("@/platform/cache/cache-invalidation");
const { CACHE_LOG_EVENT } = await import("@/platform/cache/log-event");

const REQUEST_ID = "0f1c4a0e-1d3f-4d5e-8a7b-9c0d1e2f3a4b";

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

function signOut(): void {
  getSession.mockResolvedValue(null);
}

/** Grants exactly the listed resource actions and refuses everything else. */
function grant(...granted: readonly string[]): void {
  userHasPermission.mockImplementation(
    ({ body }: { body: { permissions: PermissionRequest } }) => {
      const requested = Object.entries(body.permissions).flatMap(
        ([resource, actions]) =>
          actions.map((action) => `${resource}.${action}`),
      );

      return Promise.resolve({
        success: requested.every((permission) => granted.includes(permission)),
      });
    },
  );
}

function eventsNamed(event: string) {
  return logCalls.filter((call) => call.event === event);
}

function onlyEvent(event: string) {
  const [call, ...rest] = eventsNamed(event);

  expect(rest).toHaveLength(0);
  expect(call).toBeDefined();

  return call as NonNullable<typeof call>;
}

const productSchema = z.object({ title: z.string().min(3) });

/**
 * A module-owned identity, declared here rather than in the cache platform.
 *
 * Business vocabulary belongs to the module that owns the data; the platform
 * only knows how to validate an identity and turn it into a tag or a key.
 */
const catalogIdentity = createCacheIdentity({
  module: "catalog",
  resource: "product",
  version: 1,
  segments: [],
});

beforeEach(() => {
  getSession.mockReset();
  userHasPermission.mockReset();
  revalidatePath.mockReset();
  revalidateTag.mockReset();
  updateTag.mockReset();
  logCalls.length = 0;
  signOut();
  grant();
});

describe("defineAction typing", () => {
  it("infers the input from the schema and the output from the use case", () => {
    const action = defineAction({
      name: "catalog.product.describe",
      input: z.object({ id: z.string() }),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ input, actor }) => {
        expectTypeOf(input).toEqualTypeOf<{ id: string }>();
        expectTypeOf(actor).toEqualTypeOf<null>();

        return { label: input.id.toUpperCase() };
      },
    });

    expectTypeOf(action).parameter(0).toEqualTypeOf<unknown>();
    expectTypeOf(action).returns.resolves.toEqualTypeOf<
      ActionResult<{ label: string }>
    >();
  });

  it("infers a transformed input type rather than the raw one", () => {
    const action = defineAction({
      name: "catalog.product.measure",
      input: z.object({ raw: z.string() }).transform(({ raw }) => ({
        length: raw.length,
      })),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ input }) => {
        expectTypeOf(input).toEqualTypeOf<{ length: number }>();

        return input.length;
      },
    });

    expectTypeOf(action).returns.resolves.toEqualTypeOf<ActionResult<number>>();
  });

  it("guarantees the actor for every protected mode", () => {
    defineAction({
      name: "catalog.product.audit",
      input: z.object({ id: z.string() }),
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: ({ actor }) => {
        expectTypeOf(actor).toEqualTypeOf<Actor>();

        return actor.userId;
      },
    });

    defineAction({
      name: "identity.user.promote",
      input: z.object({ id: z.string() }),
      authorization: {
        mode: AUTHORIZATION_MODE.ALL_PERMISSIONS,
        permissions: [
          PERMISSION.IDENTITY_USER_READ,
          PERMISSION.IDENTITY_USER_SET_ROLE,
        ],
      },
      execute: ({ actor }) => {
        expectTypeOf(actor).toEqualTypeOf<Actor>();

        return actor.userId;
      },
    });
  });

  it("types every hook context from the same schema and mode", () => {
    defineAction({
      name: "catalog.product.create",
      input: productSchema,
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: ({ input }) => ({ id: input.title }),
      hooks: {
        beforeExecute: [
          ({ input, actor, actionName }) => {
            expectTypeOf(input).toEqualTypeOf<{ title: string }>();
            expectTypeOf(actor).toEqualTypeOf<Actor>();
            expectTypeOf(actionName).toEqualTypeOf<string>();
          },
        ],
        afterSuccess: [
          ({ input, actor, output }) => {
            expectTypeOf(input).toEqualTypeOf<{ title: string }>();
            expectTypeOf(actor).toEqualTypeOf<Actor>();
            expectTypeOf(output).toEqualTypeOf<{ id: string }>();
          },
        ],
        afterFailure: [
          ({ input, actor, error }) => {
            expectTypeOf(input).toEqualTypeOf<{ title: string } | null>();
            expectTypeOf(actor).toEqualTypeOf<Actor | null>();
            expectTypeOf(error.code).toEqualTypeOf<
              (typeof ERROR_CODE)[keyof typeof ERROR_CODE]
            >();
          },
        ],
      },
    });
  });
});

describe("input validation", () => {
  it("passes the parsed value to the use case", async () => {
    const execute = vi.fn(({ input }: { input: { title: string } }) => input);
    const action = defineAction({
      name: "catalog.product.create",
      input: productSchema,
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute,
    });

    await expect(action({ title: "Notebook" })).resolves.toEqual({
      ok: true,
      data: { title: "Notebook" },
    });
  });

  it("applies a transform before the use case runs", async () => {
    const action = defineAction({
      name: "catalog.product.measure",
      input: z
        .object({ raw: z.string() })
        .transform(({ raw }) => ({ length: raw.length })),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ input }) => input,
    });

    await expect(action({ raw: "abcd" })).resolves.toEqual({
      ok: true,
      data: { length: 4 },
    });
  });

  it("awaits an async refinement", async () => {
    const action = defineAction({
      name: "catalog.product.reserve",
      input: z.object({
        title: z.string().refine(
          async (value) => {
            await Promise.resolve();

            return value !== "reserved";
          },
          { message: "The title is reserved." },
        ),
      }),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ input }) => input.title,
    });

    await expect(action({ title: "Notebook" })).resolves.toEqual({
      ok: true,
      data: "Notebook",
    });
    await expect(action({ title: "reserved" })).resolves.toEqual({
      ok: false,
      error: { code: ERROR_CODE.VALIDATION_FAILED },
    });
  });

  it("refuses an invalid input as VALIDATION_FAILED without reaching the use case", async () => {
    const execute = vi.fn();
    const action = defineAction({
      name: "catalog.product.create",
      input: productSchema,
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute,
    });

    await expect(action({ title: "no" })).resolves.toEqual({
      ok: false,
      error: { code: ERROR_CODE.VALIDATION_FAILED },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("discloses nothing about the refused payload", async () => {
    const action = defineAction({
      name: "catalog.product.create",
      input: z.object({
        title: z.string().min(3),
        password: z.string(),
      }),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ input }) => input.title,
    });

    const result = await action({ title: "no", password: "correct horse" });
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      ok: false,
      error: { code: ERROR_CODE.VALIDATION_FAILED },
    });
    expect(Object.keys(result.ok ? {} : result.error)).toEqual(["code"]);
    expect(serialized).not.toContain("title");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("correct horse");
    expect(serialized).not.toContain("issues");
    expect(JSON.stringify(logCalls)).not.toContain("correct horse");
  });

  it("refuses a completely unexpected argument", async () => {
    const action = defineAction({
      name: "catalog.product.create",
      input: productSchema,
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ input }) => input,
    });

    for (const value of [undefined, null, "text", 42, []]) {
      await expect(action(value)).resolves.toEqual({
        ok: false,
        error: { code: ERROR_CODE.VALIDATION_FAILED },
      });
    }
  });
});

describe("authorization", () => {
  it("runs a public Action without reading a session", async () => {
    const action = defineAction({
      name: "catalog.product.list",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: ({ actor }) => ({ actor }),
    });

    await expect(action({})).resolves.toEqual({
      ok: true,
      data: { actor: null },
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(userHasPermission).not.toHaveBeenCalled();
  });

  it("resolves the actor for an authenticated Action", async () => {
    signIn();

    const action = defineAction({
      name: "catalog.product.mine",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: ({ actor }) => actor.userId,
    });

    await expect(action({})).resolves.toEqual({ ok: true, data: "user-1" });
    expect(userHasPermission).not.toHaveBeenCalled();
  });

  it("refuses an authenticated Action for a missing actor", async () => {
    const execute = vi.fn();
    const action = defineAction({
      name: "catalog.product.mine",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute,
    });

    await expect(action({})).resolves.toEqual({
      ok: false,
      error: { code: ERROR_CODE.UNAUTHENTICATED },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires a single capability", async () => {
    signIn();
    grant("identity.user.set-role");

    const action = defineAction({
      name: "identity.user.promote",
      input: z.object({ userId: z.string() }),
      authorization: {
        mode: AUTHORIZATION_MODE.PERMISSION,
        permission: PERMISSION.IDENTITY_USER_SET_ROLE,
      },
      execute: ({ input }) => input.userId,
    });

    await expect(action({ userId: "user-2" })).resolves.toEqual({
      ok: true,
      data: "user-2",
    });
    expect(userHasPermission).toHaveBeenCalledExactlyOnceWith({
      body: {
        userId: "user-1",
        permissions: { "identity.user": ["set-role"] },
      },
    });
  });

  it("accepts any one of the listed capabilities", async () => {
    signIn();
    grant("identity.audit.read");

    const action = defineAction({
      name: "identity.overview.read",
      input: z.object({}),
      authorization: {
        mode: AUTHORIZATION_MODE.ANY_PERMISSION,
        permissions: [
          PERMISSION.IDENTITY_USER_LIST,
          PERMISSION.IDENTITY_AUDIT_READ,
        ],
      },
      execute: () => "granted",
    });

    await expect(action({})).resolves.toEqual({ ok: true, data: "granted" });
  });

  it("requires every listed capability", async () => {
    signIn();
    grant("identity.user.read");

    const action = defineAction({
      name: "identity.user.promote",
      input: z.object({}),
      authorization: {
        mode: AUTHORIZATION_MODE.ALL_PERMISSIONS,
        permissions: [
          PERMISSION.IDENTITY_USER_READ,
          PERMISSION.IDENTITY_USER_SET_ROLE,
        ],
      },
      execute: () => "granted",
    });

    await expect(action({})).resolves.toEqual({
      ok: false,
      error: { code: ERROR_CODE.FORBIDDEN },
    });

    grant("identity.user.read", "identity.user.set-role");

    await expect(action({})).resolves.toEqual({ ok: true, data: "granted" });
  });

  it("refuses a capability the actor does not hold, without reaching the use case", async () => {
    signIn();

    const execute = vi.fn();
    const action = defineAction({
      name: "identity.user.promote",
      input: z.object({}),
      authorization: {
        mode: AUTHORIZATION_MODE.PERMISSION,
        permission: PERMISSION.IDENTITY_USER_SET_ROLE,
      },
      execute,
    });

    await expect(action({})).resolves.toEqual({
      ok: false,
      error: { code: ERROR_CODE.FORBIDDEN },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates the input before it evaluates a capability", async () => {
    signIn();
    grant("identity.user.set-role");

    const action = defineAction({
      name: "identity.user.promote",
      input: z.object({ userId: z.string().min(1) }),
      authorization: {
        mode: AUTHORIZATION_MODE.PERMISSION,
        permission: PERMISSION.IDENTITY_USER_SET_ROLE,
      },
      execute: ({ input }) => input.userId,
    });

    await expect(action({ userId: "" })).resolves.toEqual({
      ok: false,
      error: { code: ERROR_CODE.VALIDATION_FAILED },
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(userHasPermission).not.toHaveBeenCalled();
  });
});

describe("error mapping", () => {
  it("maps a known application error to its code", async () => {
    const action = defineAction({
      name: "catalog.product.read",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => {
        throw new NotFoundError("The product row is absent from the catalog.");
      },
    });

    await expect(action({})).resolves.toEqual({
      ok: false,
      error: { code: ERROR_CODE.NOT_FOUND },
    });
  });

  it.each([
    { name: "an unexpected Error", thrown: new Error("Connection reset") },
    { name: "a thrown string", thrown: "Connection reset" },
    { name: "a thrown null", thrown: null },
    {
      name: "a Prisma-like object",
      thrown: { code: "P2002", meta: { target: ["email"] } },
    },
  ])("maps $name to INTERNAL_ERROR", async ({ thrown }) => {
    const action = defineAction({
      name: "catalog.product.create",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => {
        throw thrown;
      },
    });

    await expect(action({})).resolves.toEqual({
      ok: false,
      error: { code: ERROR_CODE.INTERNAL_ERROR },
    });
  });

  it("never returns a message, a stack, or a cause", async () => {
    const action = defineAction({
      name: "catalog.product.create",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => {
        throw new ConflictError("Duplicate slug in schema catalog_private", {
          cause: new Error("SELECT * FROM catalog_private"),
        });
      },
    });

    const result = await action({});
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      ok: false,
      error: { code: ERROR_CODE.CONFLICT },
    });
    expect(serialized).not.toContain("catalog_private");
    expect(serialized).not.toContain("stack");
    expect(JSON.stringify(logCalls)).not.toContain("catalog_private");
  });

  it("returns a result rather than throwing, for every failure point", async () => {
    signIn();

    const cases = [
      defineAction({
        name: "failure.validation",
        input: z.object({ id: z.string() }),
        authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
        execute: () => "unreachable",
      })(null),
      defineAction({
        name: "failure.authorization",
        input: z.object({}),
        authorization: {
          mode: AUTHORIZATION_MODE.PERMISSION,
          permission: PERMISSION.IDENTITY_USER_SET_ROLE,
        },
        execute: () => "unreachable",
      })({}),
      defineAction({
        name: "failure.before-hook",
        input: z.object({}),
        authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
        execute: () => "unreachable",
        hooks: {
          beforeExecute: [
            () => {
              throw new ConflictError("The gate refused the call.");
            },
          ],
        },
      })({}),
      defineAction({
        name: "failure.use-case",
        input: z.object({}),
        authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
        execute: () => {
          throw new Error("Unexpected");
        },
      })({}),
    ];

    for (const pending of cases) {
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(Object.keys(result)).toEqual(["ok", "error"]);
    }
  });
});

describe("hooks", () => {
  it("runs the lifecycle in a fixed order", async () => {
    signIn();
    grant("identity.user.set-role");

    const order: string[] = [];
    // A hook's return value is ignored, so the type refuses one. `push` returns
    // a length, which is exactly the mistake that refusal is there to catch.
    const step = (name: string): void => {
      order.push(name);
    };

    const action = defineAction({
      name: "identity.user.promote",
      input: z.object({ userId: z.string() }).transform((value) => {
        order.push("validate");

        return value;
      }),
      authorization: {
        mode: AUTHORIZATION_MODE.PERMISSION,
        permission: PERMISSION.IDENTITY_USER_SET_ROLE,
      },
      execute: () => {
        order.push("execute");

        return "promoted";
      },
      hooks: {
        beforeExecute: [() => step("before-1"), () => step("before-2")],
        afterSuccess: [
          () => step("after-success-1"),
          () => step("after-success-2"),
        ],
        afterFailure: [() => step("after-failure")],
      },
      revalidate: { paths: [{ path: "/admin/users" }] },
    });

    revalidatePath.mockImplementation(() => step("revalidate"));

    await expect(action({ userId: "user-2" })).resolves.toEqual({
      ok: true,
      data: "promoted",
    });
    expect(order).toEqual([
      "validate",
      "before-1",
      "before-2",
      "execute",
      "after-success-1",
      "after-success-2",
      "revalidate",
    ]);
  });

  it("lets a beforeExecute hook prevent the use case", async () => {
    const execute = vi.fn();
    const action = defineAction({
      name: "catalog.product.create",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute,
      hooks: {
        beforeExecute: [
          () => {
            throw new ConflictError("A draft is already open.");
          },
        ],
        afterSuccess: [vi.fn()],
      },
    });

    await expect(action({})).resolves.toEqual({
      ok: false,
      error: { code: ERROR_CODE.CONFLICT },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("stops at the first failing beforeExecute hook", async () => {
    const second = vi.fn();
    const action = defineAction({
      name: "catalog.product.create",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => "created",
      hooks: {
        beforeExecute: [
          () => {
            throw new ConflictError("A draft is already open.");
          },
          second,
        ],
      },
    });

    await action({});

    expect(second).not.toHaveBeenCalled();
  });

  it("runs afterSuccess only on success and afterFailure only on failure", async () => {
    const afterSuccess = vi.fn();
    const afterFailure = vi.fn();

    const build = (shouldFail: boolean) =>
      defineAction({
        name: "catalog.product.create",
        input: z.object({}),
        authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
        execute: () => {
          if (shouldFail) {
            throw new ConflictError("Duplicate draft.");
          }

          return "created";
        },
        hooks: { afterSuccess: [afterSuccess], afterFailure: [afterFailure] },
      });

    await build(false)({});

    expect(afterSuccess).toHaveBeenCalledOnce();
    expect(afterFailure).not.toHaveBeenCalled();

    afterSuccess.mockReset();

    await build(true)({});

    expect(afterSuccess).not.toHaveBeenCalled();
    expect(afterFailure).toHaveBeenCalledOnce();
  });

  it("gives afterSuccess the validated input, the actor, and the output", async () => {
    signIn();

    const afterSuccess = vi.fn();

    await runWithRequestContext({ requestId: REQUEST_ID }, () =>
      defineAction({
        name: "catalog.product.create",
        input: productSchema,
        authorization: { mode: AUTHORIZATION_MODE.ACTOR },
        execute: ({ input }) => ({ id: input.title.toLowerCase() }),
        hooks: { afterSuccess: [afterSuccess] },
      })({ title: "Notebook" }),
    );

    expect(afterSuccess).toHaveBeenCalledExactlyOnceWith({
      actionName: "catalog.product.create",
      input: { title: "Notebook" },
      actor: signedInActor,
      requestId: REQUEST_ID,
      output: { id: "notebook" },
    });
  });

  it("gives afterFailure the public error and no raw error", async () => {
    const afterFailure = vi.fn();

    await defineAction({
      name: "catalog.product.create",
      input: productSchema,
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => {
        throw new ConflictError("Duplicate slug in catalog_private", {
          cause: new Error("SELECT 1"),
        });
      },
      hooks: { afterFailure: [afterFailure] },
    })({ title: "Notebook" });

    expect(afterFailure).toHaveBeenCalledExactlyOnceWith({
      actionName: "catalog.product.create",
      input: { title: "Notebook" },
      actor: null,
      error: { code: ERROR_CODE.CONFLICT },
    });
    expect(JSON.stringify(afterFailure.mock.calls)).not.toContain(
      "catalog_private",
    );
  });

  it("carries the request id into a failure observer", async () => {
    const afterFailure = vi.fn();

    await runWithRequestContext({ requestId: REQUEST_ID }, () =>
      defineAction({
        name: "catalog.product.create",
        input: productSchema,
        authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
        execute: () => {
          throw new NotFoundError("The product is absent.");
        },
        hooks: { afterFailure: [afterFailure] },
      })({ title: "Notebook" }),
    );

    expect(afterFailure).toHaveBeenCalledExactlyOnceWith({
      actionName: "catalog.product.create",
      input: { title: "Notebook" },
      actor: null,
      requestId: REQUEST_ID,
      error: { code: ERROR_CODE.NOT_FOUND },
    });
  });

  it("reports a null input and a null actor when the failure preceded them", async () => {
    const afterFailure = vi.fn();

    await defineAction({
      name: "catalog.product.create",
      input: productSchema,
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: () => "created",
      hooks: { afterFailure: [afterFailure] },
    })({ title: "no" });

    expect(afterFailure).toHaveBeenCalledExactlyOnceWith({
      actionName: "catalog.product.create",
      input: null,
      actor: null,
      error: { code: ERROR_CODE.VALIDATION_FAILED },
    });
  });

  it("keeps a completed mutation successful when afterSuccess fails", async () => {
    const second = vi.fn();
    const action = defineAction({
      name: "catalog.product.create",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => "created",
      hooks: {
        afterSuccess: [
          () => {
            throw new Error("The audit store is unavailable");
          },
          second,
        ],
      },
    });

    await expect(action({})).resolves.toEqual({ ok: true, data: "created" });
    expect(second).toHaveBeenCalledOnce();

    const failure = onlyEvent(SERVER_ACTION_LOG_EVENT.HOOK_FAILED);

    expect(failure.level).toBe("error");
    expect(failure.fields).toEqual({
      actionName: "catalog.product.create",
      hookName: ACTION_HOOK.AFTER_SUCCESS,
      errorCode: ERROR_CODE.INTERNAL_ERROR,
    });
    expect(JSON.stringify(logCalls)).not.toContain(
      "audit store is unavailable",
    );
  });

  it("keeps the original failure when afterFailure fails", async () => {
    const action = defineAction({
      name: "catalog.product.create",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => {
        throw new NotFoundError("The product is absent.");
      },
      hooks: {
        afterFailure: [
          () => {
            throw new Error("The notifier is unavailable");
          },
        ],
      },
    });

    await expect(action({})).resolves.toEqual({
      ok: false,
      error: { code: ERROR_CODE.NOT_FOUND },
    });
    expect(onlyEvent(SERVER_ACTION_LOG_EVENT.HOOK_FAILED).fields).toMatchObject(
      {
        hookName: ACTION_HOOK.AFTER_FAILURE,
      },
    );
  });
});

describe("cache invalidation", () => {
  it("invalidates the declared paths and tags after a success", async () => {
    const action = defineAction({
      name: "catalog.product.create",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => "created",
      revalidate: {
        paths: [{ path: "/catalog" }],
        tags: [{ identity: catalogIdentity }],
      },
    });

    await expect(action({})).resolves.toEqual({ ok: true, data: "created" });
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith(
      "/catalog",
      undefined,
    );
    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith(
      "catalog:product:v1",
      "max",
    );
    expect(updateTag).not.toHaveBeenCalled();
  });

  it("expires a tag immediately when the Action asks to read its own write", async () => {
    const action = defineAction({
      name: "catalog.product.create",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => "created",
      revalidate: {
        tags: [
          {
            identity: catalogIdentity,
            strategy: TAG_STRATEGY.READ_YOUR_OWN_WRITES,
          },
        ],
      },
    });

    await expect(action({})).resolves.toEqual({ ok: true, data: "created" });
    expect(updateTag).toHaveBeenCalledExactlyOnceWith("catalog:product:v1");
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("attempts every target even after one of them fails", async () => {
    revalidatePath.mockImplementationOnce(() => {
      throw new Error("the first target is unavailable");
    });

    const action = defineAction({
      name: "catalog.product.create",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => "created",
      revalidate: {
        paths: [{ path: "/catalog" }, { path: "/catalog/latest" }],
        tags: [{ identity: catalogIdentity }],
      },
    });

    await expect(action({})).resolves.toEqual({ ok: true, data: "created" });
    expect(revalidatePath).toHaveBeenCalledTimes(2);
    expect(revalidateTag).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "a validation failure",
      build: () =>
        defineAction({
          name: "catalog.product.create",
          input: z.object({ id: z.string() }),
          authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
          execute: () => "created",
          revalidate: { paths: [{ path: "/catalog" }] },
        })(null),
    },
    {
      name: "an authorization failure",
      build: () =>
        defineAction({
          name: "identity.user.promote",
          input: z.object({}),
          authorization: { mode: AUTHORIZATION_MODE.ACTOR },
          execute: () => "created",
          revalidate: { paths: [{ path: "/catalog" }] },
        })({}),
    },
    {
      name: "a beforeExecute failure",
      build: () =>
        defineAction({
          name: "catalog.product.create",
          input: z.object({}),
          authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
          execute: () => "created",
          hooks: {
            beforeExecute: [
              () => {
                throw new ConflictError("Refused.");
              },
            ],
          },
          revalidate: { paths: [{ path: "/catalog" }] },
        })({}),
    },
    {
      name: "a use case failure",
      build: () =>
        defineAction({
          name: "catalog.product.create",
          input: z.object({}),
          authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
          execute: () => {
            throw new Error("Unexpected");
          },
          revalidate: { paths: [{ path: "/catalog" }] },
        })({}),
    },
  ])("invalidates nothing after $name", async ({ build }) => {
    await expect(build()).resolves.toMatchObject({ ok: false });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("keeps a completed mutation successful when invalidation fails", async () => {
    revalidatePath.mockImplementation(() => {
      throw new Error("Revalidation is unavailable at /catalog");
    });

    const action = defineAction({
      name: "catalog.product.create",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => "created",
      revalidate: { paths: [{ path: "/catalog" }] },
    });

    await expect(action({})).resolves.toEqual({ ok: true, data: "created" });

    // The failure is reported by the invalidation system rather than by the
    // factory, so there is one line for it wherever invalidation runs from.
    expect(onlyEvent(CACHE_LOG_EVENT.INVALIDATION_FAILED).fields).toEqual({
      module: "cache",
      operation: "cache-invalidation",
      errorCode: ERROR_CODE.INTERNAL_ERROR,
    });
    expect(eventsNamed(SERVER_ACTION_LOG_EVENT.HOOK_FAILED)).toHaveLength(0);
  });
});

describe("logging", () => {
  it("emits a started and a succeeded event with allowlisted fields only", async () => {
    signIn();

    await runWithRequestContext({ requestId: REQUEST_ID }, () =>
      defineAction({
        name: "catalog.product.create",
        input: productSchema,
        authorization: { mode: AUTHORIZATION_MODE.ACTOR },
        execute: ({ input }) => ({ id: input.title }),
      })({ title: "Notebook" }),
    );

    expect(onlyEvent(SERVER_ACTION_LOG_EVENT.STARTED).fields).toEqual({
      actionName: "catalog.product.create",
      requestId: REQUEST_ID,
    });

    const succeeded = onlyEvent(SERVER_ACTION_LOG_EVENT.SUCCEEDED);

    expect(succeeded.level).toBe("info");
    expect(succeeded.fields).toMatchObject({
      actionName: "catalog.product.create",
      requestId: REQUEST_ID,
      actorUserId: "user-1",
      outcome: "succeeded",
    });
    expect(typeof succeeded.fields.durationMs).toBe("number");
    expect(Object.keys(succeeded.fields).toSorted()).toEqual([
      "actionName",
      "actorUserId",
      "durationMs",
      "outcome",
      "requestId",
    ]);
  });

  it("omits the request id when no request context exists", async () => {
    await defineAction({
      name: "catalog.product.list",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => "listed",
    })({});

    expect(onlyEvent(SERVER_ACTION_LOG_EVENT.STARTED).fields).toEqual({
      actionName: "catalog.product.list",
    });
  });

  it("records a refused call as a warning with its public error code", async () => {
    await defineAction({
      name: "catalog.product.mine",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: () => "listed",
    })({});

    const failed = onlyEvent(SERVER_ACTION_LOG_EVENT.FAILED);

    expect(failed.level).toBe("warn");
    expect(failed.fields).toMatchObject({
      actionName: "catalog.product.mine",
      outcome: "failed",
      errorCode: ERROR_CODE.UNAUTHENTICATED,
    });
  });

  it("attributes a refused capability to the caller that was denied", async () => {
    signIn();

    await defineAction({
      name: "identity.user.promote",
      input: z.object({}),
      authorization: {
        mode: AUTHORIZATION_MODE.PERMISSION,
        permission: PERMISSION.IDENTITY_USER_SET_ROLE,
      },
      execute: () => "promoted",
    })({});

    expect(onlyEvent(SERVER_ACTION_LOG_EVENT.FAILED).fields).toMatchObject({
      actorUserId: "user-1",
      errorCode: ERROR_CODE.FORBIDDEN,
      outcome: "failed",
    });
  });

  it("names no actor when the call was refused before authentication", async () => {
    await defineAction({
      name: "catalog.product.mine",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: () => "listed",
    })({});

    expect(onlyEvent(SERVER_ACTION_LOG_EVENT.FAILED).fields).not.toHaveProperty(
      "actorUserId",
    );
  });

  it("records an unexpected failure as an error", async () => {
    await defineAction({
      name: "catalog.product.create",
      input: z.object({}),
      authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
      execute: () => {
        throw new Error("Connection reset by peer");
      },
    })({});

    const failed = onlyEvent(SERVER_ACTION_LOG_EVENT.FAILED);

    expect(failed.level).toBe("error");
    expect(failed.fields).toMatchObject({
      errorCode: ERROR_CODE.INTERNAL_ERROR,
      outcome: "failed",
    });
    expect(JSON.stringify(logCalls)).not.toContain("Connection reset by peer");
  });

  it("never logs the input, the output, or the actor beyond its user id", async () => {
    signIn();

    await defineAction({
      name: "identity.credential.rotate",
      input: z.object({ password: z.string(), title: z.string() }),
      authorization: { mode: AUTHORIZATION_MODE.ACTOR },
      execute: () => ({ token: "issued-session-token" }),
    })({ password: "correct horse", title: "Secret Notebook" });

    const serialized = JSON.stringify(logCalls);

    expect(serialized).not.toContain("correct horse");
    expect(serialized).not.toContain("Secret Notebook");
    expect(serialized).not.toContain("issued-session-token");
    expect(serialized).not.toContain("ada@example.com");
    expect(serialized).not.toContain("Ada Lovelace");
    expect(serialized).not.toContain("session-1");
  });
});
