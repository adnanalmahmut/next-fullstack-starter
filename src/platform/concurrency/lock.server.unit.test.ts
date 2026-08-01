import { beforeEach, describe, expect, it, vi } from "vitest";

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
  acquireLock,
  extendLock,
  lockKeyFor,
  releaseLock,
  withLock,
  LOCK_STATUS,
  MAX_LOCK_LEASE_MS,
  MAX_LOCK_RETRY_DELAY_MS,
  MAX_LOCK_WAIT_TIMEOUT_MS,
  MIN_LOCK_LEASE_MS,
  WITH_LOCK_STATUS,
} = await import("./lock.server");
const { AVAILABILITY_POLICY } = await import("./availability-policy");
const { CONCURRENCY_LOG_EVENT } = await import("./log-event");

const identity = { name: "catalog.reindex", segments: ["tenant-1"] };
const options = { identity, leaseMs: 5_000 };

function stubClient(overrides: Record<string, unknown> = {}) {
  const client = {
    set: vi.fn().mockResolvedValue("OK"),
    eval: vi.fn().mockResolvedValue(1),
    ...overrides,
  };

  getRedisClient.mockResolvedValue(client);

  return client;
}

beforeEach(() => {
  getRedisClient.mockReset();
  logCalls.length = 0;
});

describe("the key", () => {
  it("is built from the identity within the lock namespace", () => {
    expect(lockKeyFor(identity)).toBe("app:test:lock:catalog.reindex:tenant-1");
  });

  it("needs no segments", () => {
    expect(lockKeyFor({ name: "catalog.reindex" })).toBe(
      "app:test:lock:catalog.reindex",
    );
  });
});

describe("acquiring", () => {
  it("takes the lock with NX and a lease", async () => {
    const client = stubClient();

    const result = await acquireLock(options);

    expect(result.status).toBe(LOCK_STATUS.ACQUIRED);
    expect(client.set).toHaveBeenCalledExactlyOnceWith(
      lockKeyFor(identity),
      expect.stringMatching(/^[0-9a-f]{32}$/),
      { condition: "NX", expiration: { type: "PX", value: 5_000 } },
    );
  });

  it("always sets a lease, so a crashed holder cannot keep it forever", async () => {
    const client = stubClient();

    await acquireLock(options);

    const setOptions = client.set.mock.calls[0]?.[2] as {
      expiration?: { value: number };
    };

    expect(setOptions.expiration?.value).toBeGreaterThan(0);
  });

  it("gives two acquisitions different tokens", async () => {
    const client = stubClient();

    await acquireLock(options);
    await acquireLock(options);

    expect(client.set.mock.calls[0]?.[1]).not.toBe(
      client.set.mock.calls[1]?.[1],
    );
  });

  it("reports contention when the caller did not want to wait", async () => {
    const client = stubClient({ set: vi.fn().mockResolvedValue(null) });

    await expect(acquireLock(options)).resolves.toEqual({
      status: LOCK_STATUS.CONTENDED,
    });
    expect(client.set).toHaveBeenCalledOnce();
  });

  it("retries until the wait timeout and then reports a timeout", async () => {
    const client = stubClient({ set: vi.fn().mockResolvedValue(null) });

    const result = await acquireLock({
      ...options,
      waitTimeoutMs: 200,
      retryDelayMs: 20,
    });

    expect(result).toEqual({ status: LOCK_STATUS.TIMEOUT });
    expect(client.set.mock.calls.length).toBeGreaterThan(1);
  });

  it("stops retrying as soon as it wins", async () => {
    const client = stubClient({
      set: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue("OK"),
    });

    const result = await acquireLock({
      ...options,
      waitTimeoutMs: 1_000,
      retryDelayMs: 5,
    });

    expect(result.status).toBe(LOCK_STATUS.ACQUIRED);
    expect(client.set).toHaveBeenCalledTimes(3);
  });

  it("answers disabled without waiting at all", async () => {
    getRedisClient.mockResolvedValue(null);

    await expect(
      acquireLock({ ...options, waitTimeoutMs: 10_000 }),
    ).resolves.toEqual({ status: LOCK_STATUS.DISABLED });
  });

  it("answers unavailable when the connection fails", async () => {
    getRedisClient.mockRejectedValue(new Error("Redis is unavailable."));

    await expect(acquireLock(options)).resolves.toEqual({
      status: LOCK_STATUS.UNAVAILABLE,
    });
  });

  it("answers unavailable when the write fails mid-wait", async () => {
    stubClient({
      set: vi.fn().mockRejectedValue(new Error("connection reset")),
    });

    await expect(acquireLock(options)).resolves.toEqual({
      status: LOCK_STATUS.UNAVAILABLE,
    });
  });
});

describe("releasing", () => {
  it("compares the token before deleting", async () => {
    const client = stubClient();
    const acquisition = await acquireLock(options);

    if (acquisition.status !== LOCK_STATUS.ACQUIRED) {
      expect.unreachable("the lock should have been acquired");
    }

    await expect(releaseLock(acquisition.handle)).resolves.toBe(true);

    const call = client.eval.mock.calls[0] as [
      string,
      { keys: string[]; arguments: string[] },
    ];

    expect(call[0]).toContain("== ARGV[1]");
    expect(call[0]).toContain("UNLINK");
    expect(call[1].arguments).toEqual([acquisition.handle.token]);
  });

  it("reports a lease it no longer owns", async () => {
    stubClient({ eval: vi.fn().mockResolvedValue(0) });

    await expect(
      releaseLock({ key: "app:test:lock:k", token: "stale", leaseMs: 1_000 }),
    ).resolves.toBe(false);
    expect(
      logCalls.filter(
        (call) => call.event === CONCURRENCY_LOG_EVENT.LOCK_RELEASE_FAILED,
      )[0]?.fields,
    ).toMatchObject({ outcome: "expired" });
  });

  it("never throws when the release itself fails", async () => {
    stubClient({
      eval: vi.fn().mockRejectedValue(new Error("connection reset")),
    });

    await expect(
      releaseLock({ key: "app:test:lock:k", token: "t", leaseMs: 1_000 }),
    ).resolves.toBe(false);
  });
});

describe("extending", () => {
  it("compares the token before extending", async () => {
    const client = stubClient();

    await expect(
      extendLock({ key: "app:test:lock:k", token: "t", leaseMs: 1_000 }, 2_000),
    ).resolves.toBe(true);

    const call = client.eval.mock.calls[0] as [
      string,
      { keys: string[]; arguments: string[] },
    ];

    expect(call[0]).toContain("== ARGV[1]");
    expect(call[0]).toContain("PEXPIRE");
    expect(call[1].arguments).toEqual(["t", "2000"]);
  });

  it("reports a lease it no longer owns", async () => {
    stubClient({ eval: vi.fn().mockResolvedValue(0) });

    await expect(
      extendLock({ key: "app:test:lock:k", token: "t", leaseMs: 1_000 }, 2_000),
    ).resolves.toBe(false);
  });

  it("refuses an unacceptable lease", async () => {
    await expect(
      extendLock(
        { key: "app:test:lock:k", token: "t", leaseMs: 1_000 },
        MAX_LOCK_LEASE_MS + 1,
      ),
    ).rejects.toThrow(/lease is not acceptable/);
  });
});

describe("withLock", () => {
  const required = {
    ...options,
    policy: AVAILABILITY_POLICY.REQUIRED,
  } as const;
  const bestEffort = {
    ...options,
    policy: AVAILABILITY_POLICY.BEST_EFFORT,
  } as const;

  it("runs the callback once and releases afterwards", async () => {
    const client = stubClient();
    const callback = vi.fn().mockResolvedValue("done");

    await expect(withLock(required, callback)).resolves.toEqual({
      status: WITH_LOCK_STATUS.EXECUTED,
      value: "done",
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(client.eval).toHaveBeenCalledOnce();
  });

  it("does not run the callback when the lock is held", async () => {
    stubClient({ set: vi.fn().mockResolvedValue(null) });

    const callback = vi.fn();

    await expect(withLock(required, callback)).resolves.toEqual({
      status: WITH_LOCK_STATUS.CONTENDED,
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it("reports a timeout without running the callback", async () => {
    stubClient({ set: vi.fn().mockResolvedValue(null) });

    const callback = vi.fn();

    await expect(
      withLock({ ...required, waitTimeoutMs: 100, retryDelayMs: 10 }, callback),
    ).resolves.toEqual({ status: WITH_LOCK_STATUS.TIMEOUT });
    expect(callback).not.toHaveBeenCalled();
  });

  it("releases even when the callback throws, and keeps the original error", async () => {
    const client = stubClient();
    const failure = new Error("the work failed");

    await expect(
      withLock(required, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(client.eval).toHaveBeenCalledOnce();
  });

  it("keeps the callback's error even when the release fails too", async () => {
    stubClient({
      eval: vi.fn().mockRejectedValue(new Error("release failed")),
    });

    const failure = new Error("the work failed");

    await expect(
      withLock(required, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it.each([
    { name: "disabled", client: null },
    { name: "unreachable", client: undefined },
  ])("refuses a required lock when Redis is $name", async ({ client }) => {
    if (client === null) {
      getRedisClient.mockResolvedValue(null);
    } else {
      getRedisClient.mockRejectedValue(new Error("Redis is unavailable."));
    }

    const callback = vi.fn();

    await expect(withLock(required, callback)).rejects.toThrow(
      /coordination lock is unavailable/,
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it("runs a best-effort callback unprotected and records the degradation", async () => {
    getRedisClient.mockResolvedValue(null);

    const callback = vi.fn().mockResolvedValue("done");

    await expect(withLock(bestEffort, callback)).resolves.toEqual({
      status: WITH_LOCK_STATUS.EXECUTED,
      value: "done",
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(
      logCalls.filter(
        (call) => call.event === CONCURRENCY_LOG_EVENT.LOCK_UNAVAILABLE,
      ),
    ).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({ outcome: "degraded" }),
      }),
    );
  });
});

describe("bounds", () => {
  it.each([MIN_LOCK_LEASE_MS - 1, MAX_LOCK_LEASE_MS + 1, 0, 1.5])(
    "refuses the lease %s",
    async (leaseMs) => {
      await expect(acquireLock({ ...options, leaseMs })).rejects.toThrow(
        /lease is not acceptable/,
      );
    },
  );

  it.each([-1, MAX_LOCK_WAIT_TIMEOUT_MS + 1, 1.5])(
    "refuses the wait timeout %s",
    async (waitTimeoutMs) => {
      await expect(acquireLock({ ...options, waitTimeoutMs })).rejects.toThrow(
        /wait timeout is not acceptable/,
      );
    },
  );

  it.each([0, MAX_LOCK_RETRY_DELAY_MS + 1, 1.5])(
    "refuses the retry delay %s",
    async (retryDelayMs) => {
      await expect(acquireLock({ ...options, retryDelayMs })).rejects.toThrow(
        /retry delay is not acceptable/,
      );
    },
  );

  it.each(["has space", "has:separator", ""])(
    "refuses the lock name %s",
    async (name) => {
      await expect(
        acquireLock({ ...options, identity: { name } }),
      ).rejects.toThrow(/identity is not acceptable/);
    },
  );

  it("refuses a malformed segment", async () => {
    await expect(
      acquireLock({
        ...options,
        identity: { name: "catalog.reindex", segments: ["a:b"] },
      }),
    ).rejects.toThrow(/segment is not acceptable/);
  });

  it("validates before it touches Redis", async () => {
    await expect(acquireLock({ ...options, leaseMs: 0 })).rejects.toThrow();
    expect(getRedisClient).not.toHaveBeenCalled();
  });
});

describe("secret hygiene", () => {
  it("logs no key or token", async () => {
    const client = stubClient();
    const acquisition = await acquireLock(options);

    if (acquisition.status !== LOCK_STATUS.ACQUIRED) {
      expect.unreachable("the lock should have been acquired");
    }

    await releaseLock(acquisition.handle);

    const serialized = JSON.stringify(logCalls);

    expect(serialized).not.toContain(acquisition.handle.token);
    expect(serialized).not.toContain("app:test:lock");
    expect(client.set).toHaveBeenCalled();
  });
});
