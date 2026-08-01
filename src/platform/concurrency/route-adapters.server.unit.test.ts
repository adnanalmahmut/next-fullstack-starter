import { beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

const consumeRateLimit = vi.fn();
const beginIdempotency = vi.fn();
const completeIdempotency = vi.fn();
const abortIdempotency = vi.fn();

vi.mock("./rate-limit.server", async () => {
  const actual = await vi.importActual<typeof import("./rate-limit.server")>(
    "./rate-limit.server",
  );

  return {
    ...actual,
    consumeRateLimit: (options: unknown) => consumeRateLimit(options),
  };
});

vi.mock("./idempotency.server", async () => {
  const actual = await vi.importActual<typeof import("./idempotency.server")>(
    "./idempotency.server",
  );

  return {
    ...actual,
    beginIdempotency: (options: unknown) => beginIdempotency(options),
    completeIdempotency: (...args: unknown[]) => completeIdempotency(...args),
    abortIdempotency: (...args: unknown[]) => abortIdempotency(...args),
  };
});

const { idempotencyLifecycle, rateLimitHook, readIdempotencyKey } =
  await import("./route-adapters.server");
const { AVAILABILITY_POLICY, RATE_LIMIT_FALLBACK } =
  await import("./availability-policy");
const { IDEMPOTENCY_BEGIN_STATUS, IDEMPOTENCY_KEY_HEADER } =
  await import("./idempotency.server");
const { RATE_LIMIT_STATUS } = await import("./rate-limit.server");
const { IDEMPOTENCY_OUTCOME, RATE_LIMIT_OUTCOME } =
  await import("@/platform/http/index.server");
const { ERROR_CODE } = await import("@/shared/errors/error-code");
const { ApplicationError } = await import("@/shared/errors/application-error");

const requestContext = {
  routeName: "identity.admin.users.list",
  method: "GET",
  requestId: "0f1c4a0e-1d3f-4d5e-8a7b-9c0d1e2f3a4b",
  headers: new Headers(),
};

const outputSchema = z.object({ id: z.string() });

function idempotencyContext(overrides: Record<string, unknown> = {}) {
  return {
    routeName: "identity.admin.users.set-role",
    requestId: requestContext.requestId,
    method: "PATCH",
    headers: new Headers({ [IDEMPOTENCY_KEY_HEADER]: "client-key-0001" }),
    actor: { userId: "user-1" },
    params: { userId: "user-2" },
    query: undefined,
    body: { role: "admin" },
    ...overrides,
  } as Parameters<ReturnType<typeof lifecycle>>[0];
}

type LifecycleOverrides = Partial<
  Omit<
    Parameters<
      typeof idempotencyLifecycle<
        Record<string, never>,
        { readonly userId: string } | null,
        { id: string }
      >
    >[0],
    "outputSchema"
  >
>;

function lifecycle(overrides: LifecycleOverrides = {}) {
  return idempotencyLifecycle<
    Record<string, never>,
    { readonly userId: string } | null,
    { id: string }
  >({
    apiVersion: "v1",
    outputSchema,
    policy: AVAILABILITY_POLICY.REQUIRED,
    ...overrides,
  });
}

function codeOf(error: unknown): string | undefined {
  return error instanceof ApplicationError ? error.code : undefined;
}

beforeEach(() => {
  consumeRateLimit.mockReset();
  beginIdempotency.mockReset();
  completeIdempotency.mockReset().mockResolvedValue("settled");
  abortIdempotency.mockReset().mockResolvedValue("settled");
});

describe("the rate-limit hook", () => {
  const options = {
    limit: 5,
    windowMs: 60_000,
    subject: () => "203.0.113.7",
    fallback: RATE_LIMIT_FALLBACK.ALLOW,
  } as const;

  it("allows a counted request", async () => {
    consumeRateLimit.mockResolvedValue({
      status: RATE_LIMIT_STATUS.ALLOWED,
      limit: 5,
      remaining: 4,
      resetAt: Date.now(),
    });

    await expect(rateLimitHook(options)(requestContext)).resolves.toEqual({
      outcome: RATE_LIMIT_OUTCOME.ALLOWED,
    });
  });

  it("refuses and passes the retry delay to the factory", async () => {
    consumeRateLimit.mockResolvedValue({
      status: RATE_LIMIT_STATUS.LIMITED,
      limit: 5,
      remaining: 0,
      resetAt: Date.now(),
      retryAfterMs: 12_000,
    });

    await expect(rateLimitHook(options)(requestContext)).resolves.toEqual({
      outcome: RATE_LIMIT_OUTCOME.REFUSED,
      retryAfterMs: 12_000,
    });
  });

  it("names the limiter after the route unless told otherwise", async () => {
    consumeRateLimit.mockResolvedValue({ status: RATE_LIMIT_STATUS.DISABLED });

    await rateLimitHook(options)(requestContext);

    expect(consumeRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: {
          name: "identity.admin.users.list",
          subject: "203.0.113.7",
        },
      }),
    );

    await rateLimitHook({ ...options, name: "global" })(requestContext);

    expect(consumeRateLimit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        identity: { name: "global", subject: "203.0.113.7" },
      }),
    );
  });

  it.each([RATE_LIMIT_STATUS.DISABLED, RATE_LIMIT_STATUS.UNAVAILABLE])(
    "lets the request through on %s when the fallback is allow",
    async (status) => {
      consumeRateLimit.mockResolvedValue({ status });

      await expect(rateLimitHook(options)(requestContext)).resolves.toEqual({
        outcome: RATE_LIMIT_OUTCOME.ALLOWED,
      });
    },
  );

  it.each([RATE_LIMIT_STATUS.DISABLED, RATE_LIMIT_STATUS.UNAVAILABLE])(
    "refuses with a dependency failure on %s when the fallback is deny",
    async (status) => {
      consumeRateLimit.mockResolvedValue({ status });

      // Deliberately not `RATE_LIMITED`: telling a caller to slow down when the
      // truth is that a dependency is down would be a lie it cannot act on.
      const error = await rateLimitHook({
        ...options,
        fallback: RATE_LIMIT_FALLBACK.DENY,
      })(requestContext).catch((thrown: unknown) => thrown);

      expect(codeOf(error)).toBe(ERROR_CODE.DEPENDENCY_UNAVAILABLE);
    },
  );
});

describe("reading the header", () => {
  it("accepts a well-formed key", () => {
    expect(
      readIdempotencyKey(
        new Headers({ [IDEMPOTENCY_KEY_HEADER]: "client-key-0001" }),
      ),
    ).toBe("client-key-0001");
  });

  it.each(["short", "has space", ""])("refuses %s", (value) => {
    expect(
      readIdempotencyKey(new Headers({ [IDEMPOTENCY_KEY_HEADER]: value })),
    ).toBeNull();
  });

  it("answers null when the header is absent", () => {
    expect(readIdempotencyKey(new Headers())).toBeNull();
  });
});

describe("the idempotency lifecycle", () => {
  it("proceeds with a reservation once the key is claimed", async () => {
    beginIdempotency.mockResolvedValue({
      status: IDEMPOTENCY_BEGIN_STATUS.ACQUIRED,
      handle: { key: "k", owner: "o", completedTtlMs: 1_000 },
    });

    const decision = await lifecycle()(idempotencyContext());

    expect(decision.outcome).toBe(IDEMPOTENCY_OUTCOME.PROCEED);

    if (decision.outcome !== IDEMPOTENCY_OUTCOME.PROCEED) {
      expect.unreachable("the attempt should proceed");
    }

    await decision.reservation?.complete({ id: "entity-1" });

    expect(completeIdempotency).toHaveBeenCalledExactlyOnceWith(
      { key: "k", owner: "o", completedTtlMs: 1_000 },
      expect.any(String),
      { id: "entity-1" },
    );

    await decision.reservation?.abort();

    expect(abortIdempotency).toHaveBeenCalledExactlyOnceWith({
      key: "k",
      owner: "o",
      completedTtlMs: 1_000,
    });
  });

  it("scopes the claim to the route, the version, and the actor", async () => {
    beginIdempotency.mockResolvedValue({
      status: IDEMPOTENCY_BEGIN_STATUS.ACQUIRED,
      handle: { key: "k", owner: "o", completedTtlMs: 1_000 },
    });

    await lifecycle()(idempotencyContext());

    expect(beginIdempotency).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          routeName: "identity.admin.users.set-role",
          apiVersion: "v1",
          subject: "user-1",
          idempotencyKey: "client-key-0001",
        },
      }),
    );
  });

  it("fingerprints the validated input rather than the raw body", async () => {
    beginIdempotency.mockResolvedValue({
      status: IDEMPOTENCY_BEGIN_STATUS.ACQUIRED,
      handle: { key: "k", owner: "o", completedTtlMs: 1_000 },
    });

    await lifecycle()(idempotencyContext());
    const first = beginIdempotency.mock.calls[0]?.[0] as {
      fingerprint: string;
    };

    await lifecycle()(idempotencyContext({ body: { role: "user" } }));
    const second = beginIdempotency.mock.calls[1]?.[0] as {
      fingerprint: string;
    };

    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("replays a stored result", async () => {
    beginIdempotency.mockResolvedValue({
      status: IDEMPOTENCY_BEGIN_STATUS.REPLAY,
      output: { id: "entity-1" },
    });

    await expect(lifecycle()(idempotencyContext())).resolves.toEqual({
      outcome: IDEMPOTENCY_OUTCOME.REPLAY,
      output: { id: "entity-1" },
    });
  });

  it("reports a conflict", async () => {
    beginIdempotency.mockResolvedValue({
      status: IDEMPOTENCY_BEGIN_STATUS.CONFLICT,
    });

    await expect(lifecycle()(idempotencyContext())).resolves.toEqual({
      outcome: IDEMPOTENCY_OUTCOME.CONFLICT,
    });
  });

  it("proceeds without a key when one is not required", async () => {
    await expect(
      lifecycle()(idempotencyContext({ headers: new Headers() })),
    ).resolves.toEqual({ outcome: IDEMPOTENCY_OUTCOME.PROCEED });
    expect(beginIdempotency).not.toHaveBeenCalled();
  });

  it("refuses a missing key as invalid input when one is required", async () => {
    const error = await Promise.resolve(
      lifecycle({ keyRequired: true })(
        idempotencyContext({ headers: new Headers() }),
      ),
    ).catch((thrown: unknown) => thrown);

    expect(codeOf(error)).toBe(ERROR_CODE.VALIDATION_FAILED);
  });

  it.each([
    IDEMPOTENCY_BEGIN_STATUS.DISABLED,
    IDEMPOTENCY_BEGIN_STATUS.UNAVAILABLE,
  ])("refuses a required attempt when the store is %s", async (status) => {
    beginIdempotency.mockResolvedValue({ status });

    const error = await Promise.resolve(
      lifecycle()(idempotencyContext()),
    ).catch((thrown: unknown) => thrown);

    expect(codeOf(error)).toBe(ERROR_CODE.DEPENDENCY_UNAVAILABLE);
  });

  it.each([
    IDEMPOTENCY_BEGIN_STATUS.DISABLED,
    IDEMPOTENCY_BEGIN_STATUS.UNAVAILABLE,
  ])("degrades a best-effort attempt when the store is %s", async (status) => {
    beginIdempotency.mockResolvedValue({ status });

    // The use case runs with no protection at all — which is exactly why this
    // policy is never acceptable for an operation that cannot be repeated.
    await expect(
      lifecycle({ policy: AVAILABILITY_POLICY.BEST_EFFORT })(
        idempotencyContext(),
      ),
    ).resolves.toEqual({ outcome: IDEMPOTENCY_OUTCOME.PROCEED });
  });

  it("uses an explicit public subject for a route with no actor", async () => {
    beginIdempotency.mockResolvedValue({
      status: IDEMPOTENCY_BEGIN_STATUS.ACQUIRED,
      handle: { key: "k", owner: "o", completedTtlMs: 1_000 },
    });

    await lifecycle({ publicSubject: () => "anonymous-tenant-1" })(
      idempotencyContext({ actor: null }),
    );

    expect(beginIdempotency).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ subject: "anonymous-tenant-1" }),
      }),
    );
  });

  it("refuses a keyed public route that declared no subject", async () => {
    // A key with no subject would be shared by every anonymous caller, so one
    // client's stored result could be replayed to another.
    const error = await Promise.resolve(
      lifecycle()(idempotencyContext({ actor: null })),
    ).catch((thrown: unknown) => thrown);

    expect(codeOf(error)).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect(beginIdempotency).not.toHaveBeenCalled();
  });

  it("passes the declared TTLs through", async () => {
    beginIdempotency.mockResolvedValue({
      status: IDEMPOTENCY_BEGIN_STATUS.ACQUIRED,
      handle: { key: "k", owner: "o", completedTtlMs: 1_000 },
    });

    await lifecycle({ processingTtlMs: 5_000, completedTtlMs: 9_000 })(
      idempotencyContext(),
    );

    expect(beginIdempotency).toHaveBeenCalledWith(
      expect.objectContaining({
        processingTtlMs: 5_000,
        completedTtlMs: 9_000,
      }),
    );
  });
});
