import { beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import type { StructuredLogger } from "@/platform/observability/create-logger.server";

const getRedisClient = vi.fn();
const logCalls: {
  level: string;
  fields: Record<string, unknown>;
  event: unknown;
}[] = [];

vi.mock("@/platform/redis/index.server", async () => {
  const actual = await vi.importActual<
    typeof import("@/platform/redis/index.server")
  >("@/platform/redis/index.server");

  return {
    ...actual,
    getRedisClient: () => getRedisClient() as unknown,
    getRedisKeyScope: () => ({ prefix: "app", environment: "test" }),
  };
});

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

const {
  abortIdempotency,
  beginIdempotency,
  completeIdempotency,
  idempotencyFingerprint,
  idempotencyKeyFor,
  isValidIdempotencyKey,
  IDEMPOTENCY_BEGIN_STATUS,
  IDEMPOTENCY_SETTLE_STATUS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_IDEMPOTENCY_PAYLOAD_BYTES,
  MAX_IDEMPOTENCY_PROCESSING_TTL_MS,
  MIN_IDEMPOTENCY_KEY_LENGTH,
  MIN_IDEMPOTENCY_PROCESSING_TTL_MS,
} = await import("./idempotency.server");
const { CONCURRENCY_LOG_EVENT } = await import("./log-event");

const scope = {
  routeName: "identity.admin.users.set-role",
  apiVersion: "v1",
  subject: "user-1",
  idempotencyKey: "client-key-0001",
};
const outputSchema = z.object({ id: z.string() });
const fingerprint = "0123456789abcdef0123456789abcdef";

function stubEval(...replies: unknown[]) {
  const evaluate = vi.fn();

  for (const reply of replies) {
    evaluate.mockResolvedValueOnce(reply);
  }

  getRedisClient.mockResolvedValue({ eval: evaluate });

  return evaluate;
}

function record(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    state: "completed",
    fingerprint,
    output: { id: "entity-1" },
    ...overrides,
  });
}

beforeEach(() => {
  getRedisClient.mockReset();
  logCalls.length = 0;
});

describe("the key", () => {
  it("is scoped by version, route, subject, and key", () => {
    expect(
      idempotencyKeyFor(scope).startsWith(
        "app:test:idempotency:v1:identity.admin.users.set-role:",
      ),
    ).toBe(true);
  });

  it("hashes both the subject and the client key out of it", () => {
    const key = idempotencyKeyFor(scope);

    expect(key).not.toContain("user-1");
    expect(key).not.toContain("client-key-0001");
  });

  it("separates two callers using the same key", () => {
    expect(idempotencyKeyFor(scope)).not.toBe(
      idempotencyKeyFor({ ...scope, subject: "user-2" }),
    );
  });

  it("separates two API versions and two routes", () => {
    expect(idempotencyKeyFor(scope)).not.toBe(
      idempotencyKeyFor({ ...scope, apiVersion: "v2" }),
    );
    expect(idempotencyKeyFor(scope)).not.toBe(
      idempotencyKeyFor({ ...scope, routeName: "identity.admin.users.read" }),
    );
  });
});

describe("the client key", () => {
  it.each([
    "client-key-0001",
    "a".repeat(MIN_IDEMPOTENCY_KEY_LENGTH),
    "A-1_2.3:4",
  ])("accepts %s", (key) => {
    expect(isValidIdempotencyKey(key)).toBe(true);
  });

  it.each([
    "short",
    "a".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1),
    "has space",
    "has/slash",
    "",
  ])("refuses %s", (key) => {
    expect(isValidIdempotencyKey(key)).toBe(false);
  });

  it.each([null, undefined, 1, {}])("refuses the non-string %s", (key) => {
    expect(isValidIdempotencyKey(key)).toBe(false);
  });
});

describe("the fingerprint", () => {
  const request = {
    method: "PATCH",
    routeName: "identity.admin.users.set-role",
    params: { userId: "user-2" },
    body: { role: "admin" },
    actorId: "user-1",
  };

  it("is stable for the same request", () => {
    expect(idempotencyFingerprint(request)).toBe(
      idempotencyFingerprint({ ...request }),
    );
  });

  it("does not depend on the order the object was built in", () => {
    expect(
      idempotencyFingerprint({
        actorId: "user-1",
        body: { role: "admin" },
        params: { userId: "user-2" },
        routeName: "identity.admin.users.set-role",
        method: "PATCH",
      }),
    ).toBe(idempotencyFingerprint(request));
  });

  it.each([
    { name: "the method", change: { method: "PUT" } },
    { name: "the route", change: { routeName: "identity.admin.users.read" } },
    { name: "a path parameter", change: { params: { userId: "user-3" } } },
    { name: "the body", change: { body: { role: "user" } } },
    { name: "the actor", change: { actorId: "user-9" } },
  ])("changes when $name changes", ({ change }) => {
    expect(idempotencyFingerprint({ ...request, ...change })).not.toBe(
      idempotencyFingerprint(request),
    );
  });

  it("discloses nothing about the request", () => {
    const digest = idempotencyFingerprint(request);

    expect(digest).toMatch(/^[0-9a-f]{32}$/);
    expect(digest).not.toContain("admin");
    expect(digest).not.toContain("user-2");
  });
});

describe("beginning an attempt", () => {
  it("claims the key when nothing holds it", async () => {
    const evaluate = stubEval(["acquired"]);

    const result = await beginIdempotency({ scope, fingerprint, outputSchema });

    expect(result.status).toBe(IDEMPOTENCY_BEGIN_STATUS.ACQUIRED);

    const call = evaluate.mock.calls[0] as [
      string,
      { keys: string[]; arguments: string[] },
    ];

    expect(call[0]).toContain("'NX'");
    expect(call[1].keys).toEqual([idempotencyKeyFor(scope)]);
  });

  it("hands back a claim the settle calls can use", async () => {
    stubEval(["acquired"]);

    const result = await beginIdempotency({ scope, fingerprint, outputSchema });

    if (result.status !== IDEMPOTENCY_BEGIN_STATUS.ACQUIRED) {
      expect.unreachable("the claim should have been acquired");
    }

    expect(result.handle.key).toBe(idempotencyKeyFor(scope));
    expect(result.handle.owner).toMatch(/^[0-9a-f]{32}$/);
  });

  it("gives two attempts different owner tokens", async () => {
    stubEval(["acquired"], ["acquired"]);

    const first = await beginIdempotency({ scope, fingerprint, outputSchema });
    const second = await beginIdempotency({ scope, fingerprint, outputSchema });

    if (
      first.status !== IDEMPOTENCY_BEGIN_STATUS.ACQUIRED ||
      second.status !== IDEMPOTENCY_BEGIN_STATUS.ACQUIRED
    ) {
      expect.unreachable("both claims should have been acquired");
    }

    expect(first.handle.owner).not.toBe(second.handle.owner);
  });

  it("conflicts while another attempt is still processing", async () => {
    stubEval([
      "existing",
      record({ state: "processing", owner: "abc", output: undefined }),
    ]);

    await expect(
      beginIdempotency({ scope, fingerprint, outputSchema }),
    ).resolves.toEqual({ status: IDEMPOTENCY_BEGIN_STATUS.CONFLICT });
  });

  it("replays a completed attempt for the same request", async () => {
    stubEval(["existing", record()]);

    await expect(
      beginIdempotency({ scope, fingerprint, outputSchema }),
    ).resolves.toEqual({
      status: IDEMPOTENCY_BEGIN_STATUS.REPLAY,
      output: { id: "entity-1" },
    });
  });

  it.each([
    {
      name: "a completed attempt for a different request",
      raw: record({ fingerprint: "ffffffffffffffffffffffffffffffff" }),
    },
    {
      name: "a processing attempt for a different request",
      raw: record({
        state: "processing",
        fingerprint: "ffffffffffffffffffffffffffffffff",
      }),
    },
    { name: "an unreadable record", raw: "{" },
    { name: "a record from an older shape", raw: record({ v: 0 }) },
    {
      name: "a record with an unknown state",
      raw: record({ state: "queued" }),
    },
  ])("conflicts on $name", async ({ raw }) => {
    stubEval(["existing", raw]);

    await expect(
      beginIdempotency({ scope, fingerprint, outputSchema }),
    ).resolves.toEqual({ status: IDEMPOTENCY_BEGIN_STATUS.CONFLICT });
  });

  it("conflicts rather than replaying an output the route no longer returns", async () => {
    stubEval(["existing", record({ output: { id: 7 } })]);

    const result = await beginIdempotency({ scope, fingerprint, outputSchema });

    expect(result).toEqual({ status: IDEMPOTENCY_BEGIN_STATUS.CONFLICT });
    expect(
      logCalls.filter(
        (call) => call.event === CONCURRENCY_LOG_EVENT.IDEMPOTENCY_CONFLICT,
      )[0]?.fields,
    ).toMatchObject({ outcome: "corrupt" });
  });

  it.each([
    {
      name: "disabled",
      client: null,
      status: IDEMPOTENCY_BEGIN_STATUS.DISABLED,
    },
  ])("answers $name when Redis is $name", async ({ client, status }) => {
    getRedisClient.mockResolvedValue(client);

    await expect(
      beginIdempotency({ scope, fingerprint, outputSchema }),
    ).resolves.toEqual({ status });
  });

  it("answers unavailable when Redis cannot be reached", async () => {
    getRedisClient.mockRejectedValue(new Error("Redis is unavailable."));

    await expect(
      beginIdempotency({ scope, fingerprint, outputSchema }),
    ).resolves.toEqual({ status: IDEMPOTENCY_BEGIN_STATUS.UNAVAILABLE });
  });

  it("answers unavailable when the script fails or answers nonsense", async () => {
    stubEval("OK");

    await expect(
      beginIdempotency({ scope, fingerprint, outputSchema }),
    ).resolves.toEqual({ status: IDEMPOTENCY_BEGIN_STATUS.UNAVAILABLE });
  });
});

describe("settling an attempt", () => {
  const handle = {
    key: "app:test:idempotency:k",
    owner: "owner-token",
    completedTtlMs: 60_000,
  };

  it("publishes the result for the owner", async () => {
    const evaluate = stubEval("completed");

    await expect(
      completeIdempotency(handle, fingerprint, { id: "entity-1" }),
    ).resolves.toBe(IDEMPOTENCY_SETTLE_STATUS.SETTLED);

    const call = evaluate.mock.calls[0] as [
      string,
      { keys: string[]; arguments: string[] },
    ];

    expect(call[0]).toContain("record.owner ~= ARGV[1]");
    expect(call[1].arguments[0]).toBe("owner-token");
    expect(JSON.parse(call[1].arguments[1] as string)).toEqual({
      v: 1,
      state: "completed",
      fingerprint,
      output: { id: "entity-1" },
    });
  });

  it("reports a lost claim rather than overwriting someone else's", async () => {
    stubEval("lost");

    await expect(
      completeIdempotency(handle, fingerprint, { id: "entity-1" }),
    ).resolves.toBe(IDEMPOTENCY_SETTLE_STATUS.LOST);
  });

  it("reports a missing claim", async () => {
    stubEval("missing");

    await expect(abortIdempotency(handle)).resolves.toBe(
      IDEMPOTENCY_SETTLE_STATUS.LOST,
    );
  });

  it("removes the claim on abort", async () => {
    const evaluate = stubEval("aborted");

    await expect(abortIdempotency(handle)).resolves.toBe(
      IDEMPOTENCY_SETTLE_STATUS.SETTLED,
    );
    expect(evaluate.mock.calls[0]?.[0]).toContain("UNLINK");
  });

  it("does not store an oversized result", async () => {
    const evaluate = stubEval("completed");

    await expect(
      completeIdempotency(handle, fingerprint, {
        id: "a".repeat(MAX_IDEMPOTENCY_PAYLOAD_BYTES),
      }),
    ).resolves.toBe(IDEMPOTENCY_SETTLE_STATUS.LOST);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("does not store a result JSON cannot represent", async () => {
    const evaluate = stubEval("completed");
    const circular: Record<string, unknown> = {};

    circular.self = circular;

    await expect(
      completeIdempotency(handle, fingerprint, circular),
    ).resolves.toBe(IDEMPOTENCY_SETTLE_STATUS.LOST);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("reports unavailable rather than throwing when Redis is gone", async () => {
    getRedisClient.mockResolvedValue(null);

    await expect(
      completeIdempotency(handle, fingerprint, { id: "entity-1" }),
    ).resolves.toBe(IDEMPOTENCY_SETTLE_STATUS.UNAVAILABLE);
  });
});

describe("bounds", () => {
  it.each([
    MIN_IDEMPOTENCY_PROCESSING_TTL_MS - 1,
    MAX_IDEMPOTENCY_PROCESSING_TTL_MS + 1,
    1.5,
  ])("refuses the processing TTL %s", async (processingTtlMs) => {
    await expect(
      beginIdempotency({ scope, fingerprint, outputSchema, processingTtlMs }),
    ).rejects.toThrow(/TTL is not acceptable/);
  });

  it.each(["has space", "has:separator", ""])(
    "refuses the route name %s",
    async (routeName) => {
      await expect(
        beginIdempotency({
          scope: { ...scope, routeName },
          fingerprint,
          outputSchema,
        }),
      ).rejects.toThrow(/scope is not acceptable/);
    },
  );

  it("refuses an empty subject", async () => {
    await expect(
      beginIdempotency({
        scope: { ...scope, subject: "" },
        fingerprint,
        outputSchema,
      }),
    ).rejects.toThrow(/subject is not acceptable/);
  });

  it("refuses a malformed client key", async () => {
    await expect(
      beginIdempotency({
        scope: { ...scope, idempotencyKey: "no" },
        fingerprint,
        outputSchema,
      }),
    ).rejects.toThrow(/key is not acceptable/);
  });

  it("refuses an empty fingerprint", async () => {
    await expect(
      beginIdempotency({ scope, fingerprint: "", outputSchema }),
    ).rejects.toThrow(/fingerprint is not acceptable/);
  });

  it("validates before it touches Redis", async () => {
    await expect(
      beginIdempotency({ scope, fingerprint: "", outputSchema }),
    ).rejects.toThrow();
    expect(getRedisClient).not.toHaveBeenCalled();
  });
});

describe("secret hygiene", () => {
  it("logs no key, fingerprint, owner token, or payload", async () => {
    stubEval(["existing", record()]);

    await beginIdempotency({ scope, fingerprint, outputSchema });

    const serialized = JSON.stringify(logCalls);

    for (const forbidden of [
      "client-key-0001",
      "user-1",
      fingerprint,
      "entity-1",
      "app:test:idempotency",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });
});
