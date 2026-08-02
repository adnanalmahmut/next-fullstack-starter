import { describe, expect, it } from "vitest";

import { readStorageEnvironment } from "./read-storage";

describe("reading the storage environment", () => {
  it("answers disabled for a source with no storage variable", () => {
    expect(readStorageEnvironment({}).STORAGE_ENABLED).toBe(false);
  });

  it("ignores every variable that is not its own", () => {
    // The schema is `.strict()`, so an unrelated variable reaching it would be
    // an error rather than an ignored extra. Picking by name is what keeps
    // `process.env` passable directly.
    const parsed = readStorageEnvironment({
      DATABASE_URL: "postgresql://localhost/db",
      REDIS_URL: "redis://localhost:6379",
      PATH: "/usr/bin",
      STORAGE_ENABLED: "true",
      STORAGE_REGION: "us-east-1",
      STORAGE_BUCKET: "application-uploads",
    });

    expect(parsed.STORAGE_ENABLED).toBe(true);
    expect(parsed.STORAGE_BUCKET).toBe("application-uploads");
  });

  it("reads every variable it declares", () => {
    const parsed = readStorageEnvironment({
      STORAGE_ENABLED: "true",
      STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      STORAGE_REGION: "us-east-1",
      STORAGE_BUCKET: "application-uploads",
      STORAGE_ACCESS_KEY_ID: "an-id",
      STORAGE_SECRET_ACCESS_KEY: "a-secret",
      STORAGE_SESSION_TOKEN: "a-token",
      STORAGE_FORCE_PATH_STYLE: "true",
      STORAGE_KEY_PREFIX: "acme",
      STORAGE_CONNECT_TIMEOUT_MS: "1000",
      STORAGE_REQUEST_TIMEOUT_MS: "2000",
      STORAGE_UPLOAD_URL_TTL_SECONDS: "300",
      STORAGE_DOWNLOAD_URL_TTL_SECONDS: "120",
      STORAGE_UPLOAD_INTENT_TTL_SECONDS: "600",
      STORAGE_FINALIZE_LEASE_MS: "5000",
      STORAGE_MAX_UPLOAD_BYTES: "1024",
      STORAGE_TEST_RUN_ID: "run-1",
    });

    expect(parsed).toEqual({
      STORAGE_ENABLED: true,
      STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      STORAGE_REGION: "us-east-1",
      STORAGE_BUCKET: "application-uploads",
      STORAGE_ACCESS_KEY_ID: "an-id",
      STORAGE_SECRET_ACCESS_KEY: "a-secret",
      STORAGE_SESSION_TOKEN: "a-token",
      STORAGE_FORCE_PATH_STYLE: true,
      STORAGE_KEY_PREFIX: "acme",
      STORAGE_CONNECT_TIMEOUT_MS: 1000,
      STORAGE_REQUEST_TIMEOUT_MS: 2000,
      STORAGE_UPLOAD_URL_TTL_SECONDS: 300,
      STORAGE_DOWNLOAD_URL_TTL_SECONDS: 120,
      STORAGE_UPLOAD_INTENT_TTL_SECONDS: 600,
      STORAGE_FINALIZE_LEASE_MS: 5000,
      STORAGE_MAX_UPLOAD_BYTES: 1024,
      STORAGE_TEST_RUN_ID: "run-1",
    });
  });

  it("names the storage scope when it refuses a value", () => {
    expect(() => readStorageEnvironment({ STORAGE_ENABLED: "true" })).toThrow(
      /Invalid storage environment variables/,
    );
  });
});
