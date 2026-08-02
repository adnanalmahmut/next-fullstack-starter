import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readStorageEnvironment = vi.hoisted(() => vi.fn());

vi.mock("@/config/env/read-storage", () => ({ readStorageEnvironment }));
vi.mock("@/config/env/index.server", () => ({
  serverEnv: { APP_ENV: "test", NODE_ENV: "test" },
}));

const {
  getStorageConfiguration,
  getStorageKeyScope,
  isStorageEnabled,
  resetStorageConfiguration,
} = await import("./config");

const DISABLED = {
  STORAGE_ENABLED: false,
  STORAGE_FORCE_PATH_STYLE: false,
  STORAGE_KEY_PREFIX: "next-fullstack-starter",
  STORAGE_CONNECT_TIMEOUT_MS: 5_000,
  STORAGE_REQUEST_TIMEOUT_MS: 15_000,
  STORAGE_UPLOAD_URL_TTL_SECONDS: 900,
  STORAGE_DOWNLOAD_URL_TTL_SECONDS: 300,
  STORAGE_UPLOAD_INTENT_TTL_SECONDS: 900,
  STORAGE_FINALIZE_LEASE_MS: 30_000,
  STORAGE_MAX_UPLOAD_BYTES: 26_214_400,
};

const ENABLED = {
  ...DISABLED,
  STORAGE_ENABLED: true,
  STORAGE_REGION: "us-east-1",
  STORAGE_BUCKET: "application-uploads",
};

beforeEach(() => {
  readStorageEnvironment.mockReset();
  resetStorageConfiguration();
});

afterEach(() => {
  resetStorageConfiguration();
});

describe("nothing happens at import time", () => {
  it("reads the environment only when it is asked", () => {
    // Importing this module must not read a credential, resolve a hostname, or
    // build a client. That is what makes storage genuinely optional rather than
    // optional-in-principle.
    expect(readStorageEnvironment).not.toHaveBeenCalled();

    readStorageEnvironment.mockReturnValue(DISABLED);
    getStorageConfiguration();

    expect(readStorageEnvironment).toHaveBeenCalledTimes(1);
  });

  it("reads once per process and reuses the answer", () => {
    readStorageEnvironment.mockReturnValue(ENABLED);

    getStorageConfiguration();
    getStorageConfiguration();
    isStorageEnabled();

    expect(readStorageEnvironment).toHaveBeenCalledTimes(1);
  });

  it("reads again after a reset", () => {
    readStorageEnvironment.mockReturnValue(DISABLED);
    getStorageConfiguration();
    resetStorageConfiguration();
    getStorageConfiguration();

    expect(readStorageEnvironment).toHaveBeenCalledTimes(2);
  });
});

describe("the disabled configuration", () => {
  it("carries the limits and nothing about a provider", () => {
    readStorageEnvironment.mockReturnValue(DISABLED);

    const configuration = getStorageConfiguration();

    expect(configuration.enabled).toBe(false);
    expect(isStorageEnabled()).toBe(false);
    expect(Object.keys(configuration).sort()).toEqual([
      "connectTimeoutMs",
      "downloadUrlTtlSeconds",
      "enabled",
      "finalizeLeaseMs",
      "keyPrefix",
      "maxUploadBytes",
      "requestTimeoutMs",
      "uploadIntentTtlSeconds",
      "uploadUrlTtlSeconds",
    ]);
  });

  it("stays disabled when a region and bucket are present but the flag is off", () => {
    readStorageEnvironment.mockReturnValue({
      ...ENABLED,
      STORAGE_ENABLED: false,
    });

    expect(getStorageConfiguration().enabled).toBe(false);
  });
});

describe("the enabled configuration", () => {
  it("carries the region, the bucket, and the limits", () => {
    readStorageEnvironment.mockReturnValue(ENABLED);

    const configuration = getStorageConfiguration();

    expect(configuration).toMatchObject({
      enabled: true,
      region: "us-east-1",
      bucket: "application-uploads",
      forcePathStyle: false,
      maxUploadBytes: 26_214_400,
    });
  });

  it("omits the endpoint when there is none, rather than inventing one", () => {
    readStorageEnvironment.mockReturnValue(ENABLED);

    expect(getStorageConfiguration()).not.toHaveProperty("endpoint");
  });

  it("omits credentials when there are none, which selects the default chain", () => {
    readStorageEnvironment.mockReturnValue(ENABLED);

    expect(getStorageConfiguration()).not.toHaveProperty("credentials");
  });

  it("carries a credential pair when both halves are configured", () => {
    readStorageEnvironment.mockReturnValue({
      ...ENABLED,
      STORAGE_ACCESS_KEY_ID: "an-id",
      STORAGE_SECRET_ACCESS_KEY: "a-secret",
    });

    expect(getStorageConfiguration()).toMatchObject({
      credentials: { accessKeyId: "an-id", secretAccessKey: "a-secret" },
    });
  });

  it("carries a session token only alongside a pair", () => {
    readStorageEnvironment.mockReturnValue({
      ...ENABLED,
      STORAGE_ACCESS_KEY_ID: "an-id",
      STORAGE_SECRET_ACCESS_KEY: "a-secret",
      STORAGE_SESSION_TOKEN: "a-token",
    });

    const configuration = getStorageConfiguration();

    expect(configuration).toMatchObject({
      credentials: { sessionToken: "a-token" },
    });
  });

  it("treats a missing region or bucket as disabled rather than asserting", () => {
    // The schema guarantees both once the flag is on; the check is repeated so
    // the narrowing is established by code rather than asserted.
    readStorageEnvironment.mockReturnValue({
      ...ENABLED,
      STORAGE_BUCKET: undefined,
    });

    expect(getStorageConfiguration().enabled).toBe(false);
  });
});

describe("the key scope", () => {
  it("carries a run identifier under test", () => {
    readStorageEnvironment.mockReturnValue({
      ...ENABLED,
      STORAGE_TEST_RUN_ID: "run-7",
    });

    expect(getStorageKeyScope()).toEqual({
      prefix: "next-fullstack-starter",
      environment: "test",
      testRunId: "run-7",
    });
  });

  it("generates a run identifier when the runner supplies none", () => {
    // Two runs against one bucket must never see each other's objects, even
    // when nobody remembered to set a variable.
    readStorageEnvironment.mockReturnValue(ENABLED);

    const scope = getStorageKeyScope();

    expect(scope.testRunId).toMatch(/^run-[0-9a-f-]{36}$/);
  });

  it("is memoized, so a second read cannot land in a different namespace", () => {
    readStorageEnvironment.mockReturnValue(ENABLED);

    expect(getStorageKeyScope()).toBe(getStorageKeyScope());
  });
});
