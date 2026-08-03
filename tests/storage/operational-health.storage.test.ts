import { loadEnvConfig } from "@next/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

loadEnvConfig(process.cwd());

const { createStorageTestClient, ensureTestBucket, readStorageTestTarget } =
  await import("../fixtures/storage.fixture");

const { checkStorageHealth, closeStorageClient, STORAGE_HEALTH_STATUS } =
  await import("@/platform/storage/index.server");

const { resetStorageConfiguration } = await import("@/platform/storage/config");
const { getStorageProvider } =
  await import("@/platform/storage/provider/storage-client.server");

const { toStorageReport } =
  await import("@/platform/health/web-readiness.server");
const { runHealthChecks } =
  await import("@/platform/health/run-health-checks.server");
const { toReadinessReport } = await import("@/platform/health/readiness");
const { createHealthRegistry } =
  await import("@/platform/health/health-registry");
const { DEPENDENCY_FAILURE_CODE, DEPENDENCY_NAME, HEALTHY_DEPENDENCY } =
  await import("@/platform/health/dependency-check");
const { HEALTH_CODE } = await import("@/platform/health/health-code");
const { DEPENDENCY_STATUS, READINESS_STATUS } =
  await import("@/platform/health/health-status");

/**
 * The storage half of readiness, against a real S3-compatible object store.
 *
 * The distinction this file exists to prove is `unavailable` against
 * `misconfigured`, and it cannot be proved anywhere else. Whether a missing
 * bucket produces `NoSuchBucket` or a bare `404`, and whether a rejected
 * credential produces `AccessDenied` or `InvalidAccessKeyId`, are facts about a
 * server's implementation of the S3 protocol — a mock would assert what this
 * repository believes rather than what a provider does, and the two differ
 * exactly where it matters.
 *
 * The difference is operational, not cosmetic: `unavailable` means wait and retry,
 * `misconfigured` means somebody has to deploy a change. A probe that reported one
 * as the other would send an operator looking in the wrong place.
 *
 * Nothing here writes an object. Every case is a metadata call.
 */
const target = readStorageTestTarget();
const testClient = createStorageTestClient(target);

/**
 * Every variable `withEnvironment` may change, and therefore every one it must put
 * back.
 *
 * The list has to be a superset of the overrides any case below passes. A variable
 * that is set but not restored leaks into every later test in the file — and a
 * leaked `STORAGE_CONNECT_TIMEOUT_MS` in particular would silently shorten the
 * budget of the healthy cases that follow.
 */
const STORAGE_VARIABLES = [
  "STORAGE_ENABLED",
  "STORAGE_ENDPOINT",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_CONNECT_TIMEOUT_MS",
  "STORAGE_REQUEST_TIMEOUT_MS",
] as const;

const original = new Map<string, string | undefined>();

async function withEnvironment(
  overrides: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  for (const name of STORAGE_VARIABLES) {
    original.set(name, process.env[name]);
  }

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  resetStorageConfiguration();
  closeStorageClient();

  try {
    await body();
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    original.clear();
    resetStorageConfiguration();
    closeStorageClient();
  }
}

/** The web registry's shape, with the database answered by a stub. */
function registryWithStorage() {
  return createHealthRegistry([
    {
      name: DEPENDENCY_NAME.DATABASE,
      timeoutMs: 2_000,
      failureCode: DEPENDENCY_FAILURE_CODE.DATABASE,
      run: async () => HEALTHY_DEPENDENCY,
    },
    {
      name: DEPENDENCY_NAME.STORAGE,
      timeoutMs: 3_000,
      failureCode: DEPENDENCY_FAILURE_CODE.STORAGE,
      run: async () => toStorageReport(await checkStorageHealth()),
    },
  ]);
}

beforeAll(async () => {
  await ensureTestBucket(testClient, target.bucket);
  resetStorageConfiguration();
  closeStorageClient();
});

afterAll(() => {
  closeStorageClient();
  testClient.destroy();
});

describe("enabled and reachable", () => {
  it("reports healthy against the real object store", async () => {
    const health = await checkStorageHealth();

    expect(health.status).toBe(STORAGE_HEALTH_STATUS.HEALTHY);
  });

  it("maps to a healthy dependency carrying no latency", async () => {
    expect(toStorageReport(await checkStorageHealth())).toEqual({
      status: DEPENDENCY_STATUS.HEALTHY,
    });
  });

  it("makes the process ready", async () => {
    const report = toReadinessReport(
      await runHealthChecks(registryWithStorage()),
    );

    expect(report.status).toBe(READINESS_STATUS.READY);
    expect(report.checks.storage).toEqual({
      status: DEPENDENCY_STATUS.HEALTHY,
    });
  });

  it("creates no object and deletes none", async () => {
    // The probe is a `HeadBucket`. A check that round-tripped a test object would
    // fill a bucket with garbage and fail on read-only credentials.
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");

    const before = await testClient.send(
      new ListObjectsV2Command({ Bucket: target.bucket, MaxKeys: 1_000 }),
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await checkStorageHealth();
    }

    const after = await testClient.send(
      new ListObjectsV2Command({ Bucket: target.bucket, MaxKeys: 1_000 }),
    );

    expect(after.KeyCount ?? 0).toBe(before.KeyCount ?? 0);
  });
});

describe("disabled, with an object store available anyway", () => {
  it("answers from configuration alone and builds no provider", async () => {
    await withEnvironment({ STORAGE_ENABLED: "false" }, async () => {
      await expect(checkStorageHealth()).resolves.toEqual({
        status: STORAGE_HEALTH_STATUS.DISABLED,
      });

      // MinIO is running and reachable; no client was constructed for it.
      expect(getStorageProvider()).toBeNull();
    });
  });

  it("keeps the process ready", async () => {
    await withEnvironment({ STORAGE_ENABLED: "false" }, async () => {
      const report = toReadinessReport(
        await runHealthChecks(registryWithStorage()),
      );

      expect(report.status).toBe(READINESS_STATUS.READY);
      expect(report.checks.storage).toEqual({
        status: DEPENDENCY_STATUS.DISABLED,
      });
    });
  });
});

describe("misconfigured", () => {
  it("reports misconfigured for a bucket that does not exist", async () => {
    await withEnvironment(
      { STORAGE_BUCKET: "nfs-storage-test-absent-bucket" },
      async () => {
        // The provider answered and said no. Restarting will not fix it, so this is
        // deliberately not the retryable code.
        await expect(checkStorageHealth()).resolves.toEqual({
          status: STORAGE_HEALTH_STATUS.MISCONFIGURED,
        });
      },
    );
  });

  it("reports misconfigured for a credential the provider refuses", async () => {
    await withEnvironment(
      {
        STORAGE_ACCESS_KEY_ID: "wrongtestaccesskey",
        STORAGE_SECRET_ACCESS_KEY: "wrongtestsecretaccesskey",
      },
      async () => {
        await expect(checkStorageHealth()).resolves.toEqual({
          status: STORAGE_HEALTH_STATUS.MISCONFIGURED,
        });
      },
    );
  });

  it("reports misconfigured when the variables themselves do not parse", async () => {
    await withEnvironment({ STORAGE_BUCKET: undefined }, async () => {
      await expect(checkStorageHealth()).resolves.toEqual({
        status: STORAGE_HEALTH_STATUS.MISCONFIGURED,
      });
    });
  });

  it("makes the process unready with its own code", async () => {
    await withEnvironment(
      { STORAGE_BUCKET: "nfs-storage-test-absent-bucket" },
      async () => {
        const report = toReadinessReport(
          await runHealthChecks(registryWithStorage()),
        );

        expect(report.status).toBe(READINESS_STATUS.NOT_READY);
        expect(report.checks.storage).toEqual({
          status: DEPENDENCY_STATUS.UNHEALTHY,
          code: HEALTH_CODE.STORAGE_MISCONFIGURED,
        });
      },
    );
  });
});

describe("unavailable", () => {
  it("reports unavailable for an endpoint nothing listens on", async () => {
    await withEnvironment(
      {
        STORAGE_ENDPOINT: "http://127.0.0.1:9199",
        STORAGE_CONNECT_TIMEOUT_MS: "300",
      },
      async () => {
        // Worth retrying, and reported as a different code from a refusal.
        await expect(checkStorageHealth()).resolves.toEqual({
          status: STORAGE_HEALTH_STATUS.UNAVAILABLE,
        });
      },
    );
  });

  it("makes the process unready with the retryable code", async () => {
    await withEnvironment(
      { STORAGE_ENDPOINT: "http://127.0.0.1:9199" },
      async () => {
        const report = toReadinessReport(
          await runHealthChecks(registryWithStorage()),
        );

        expect(report.status).toBe(READINESS_STATUS.NOT_READY);
        expect(report.checks.storage).toEqual({
          status: DEPENDENCY_STATUS.UNHEALTHY,
          code: HEALTH_CODE.STORAGE_UNAVAILABLE,
        });
      },
    );
  });

  it("keeps the two failure codes distinct, which is the operational point", async () => {
    let misconfigured = "";
    let unavailable = "";

    await withEnvironment(
      { STORAGE_BUCKET: "nfs-storage-test-absent-bucket" },
      async () => {
        const report = toReadinessReport(
          await runHealthChecks(registryWithStorage()),
        );

        misconfigured = JSON.stringify(report.checks.storage);
      },
    );

    await withEnvironment(
      { STORAGE_ENDPOINT: "http://127.0.0.1:9199" },
      async () => {
        const report = toReadinessReport(
          await runHealthChecks(registryWithStorage()),
        );

        unavailable = JSON.stringify(report.checks.storage);
      },
    );

    expect(misconfigured).not.toBe(unavailable);
  });
});

describe("sanitization", () => {
  it.each([
    {
      name: "a healthy probe",
      overrides: {} as Record<string, string | undefined>,
    },
    {
      name: "a missing bucket",
      overrides: { STORAGE_BUCKET: "nfs-storage-test-absent-bucket" },
    },
    {
      name: "a refused credential",
      overrides: {
        STORAGE_ACCESS_KEY_ID: "wrongtestaccesskey",
        STORAGE_SECRET_ACCESS_KEY: "wrongtestsecretaccesskey",
      },
    },
    {
      name: "an unreachable endpoint",
      overrides: { STORAGE_ENDPOINT: "http://127.0.0.1:9199" },
    },
  ])(
    "names no bucket, endpoint, or credential after $name",
    async ({ overrides }) => {
      await withEnvironment(overrides, async () => {
        const report = toReadinessReport(
          await runHealthChecks(registryWithStorage()),
        );
        const serialized = JSON.stringify(report);

        for (const forbidden of [
          target.bucket,
          target.endpoint,
          target.accessKeyId,
          target.secretAccessKey,
          "nfs-storage-test-absent-bucket",
          "wrongtestaccesskey",
          "wrongtestsecretaccesskey",
          "127.0.0.1",
          "NoSuchBucket",
          "AccessDenied",
          "InvalidAccessKeyId",
          "SignatureDoesNotMatch",
          "message",
          "stack",
          "$metadata",
        ]) {
          expect(serialized, forbidden).not.toContain(forbidden);
        }
      });
    },
  );
});
