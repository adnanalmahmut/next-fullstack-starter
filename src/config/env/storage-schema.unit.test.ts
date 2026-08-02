import { describe, expect, it } from "vitest";

import {
  DEFAULT_STORAGE_CONNECT_TIMEOUT_MS,
  DEFAULT_STORAGE_DOWNLOAD_URL_TTL_SECONDS,
  DEFAULT_STORAGE_FINALIZE_LEASE_MS,
  DEFAULT_STORAGE_KEY_PREFIX,
  DEFAULT_STORAGE_MAX_UPLOAD_BYTES,
  DEFAULT_STORAGE_REQUEST_TIMEOUT_MS,
  DEFAULT_STORAGE_UPLOAD_INTENT_TTL_SECONDS,
  DEFAULT_STORAGE_UPLOAD_URL_TTL_SECONDS,
  MAX_STORAGE_MAX_UPLOAD_BYTES,
  storageEnvironmentSchema,
} from "./schema";

function parse(values: Record<string, string>) {
  return storageEnvironmentSchema.safeParse(values);
}

function issuePaths(values: Record<string, string>) {
  const result = parse(values);

  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
}

const enabled = {
  STORAGE_ENABLED: "true",
  STORAGE_REGION: "us-east-1",
  STORAGE_BUCKET: "application-uploads",
};

describe("with no storage variable at all", () => {
  it("is valid and disabled", () => {
    const result = parse({});

    expect(result.success).toBe(true);
    expect(result.data?.STORAGE_ENABLED).toBe(false);
  });

  it("requires nothing else", () => {
    // The application has to build, boot, and pass its whole suite with no
    // bucket anywhere. A missing region cannot be allowed to fail validation
    // the way a missing `DATABASE_URL` does.
    expect(parse({ STORAGE_ENABLED: "false" }).success).toBe(true);
  });

  it("supplies every default", () => {
    const parsed = parse({}).data;

    expect(parsed).toMatchObject({
      STORAGE_KEY_PREFIX: DEFAULT_STORAGE_KEY_PREFIX,
      STORAGE_FORCE_PATH_STYLE: false,
      STORAGE_CONNECT_TIMEOUT_MS: DEFAULT_STORAGE_CONNECT_TIMEOUT_MS,
      STORAGE_REQUEST_TIMEOUT_MS: DEFAULT_STORAGE_REQUEST_TIMEOUT_MS,
      STORAGE_UPLOAD_URL_TTL_SECONDS: DEFAULT_STORAGE_UPLOAD_URL_TTL_SECONDS,
      STORAGE_DOWNLOAD_URL_TTL_SECONDS:
        DEFAULT_STORAGE_DOWNLOAD_URL_TTL_SECONDS,
      STORAGE_UPLOAD_INTENT_TTL_SECONDS:
        DEFAULT_STORAGE_UPLOAD_INTENT_TTL_SECONDS,
      STORAGE_FINALIZE_LEASE_MS: DEFAULT_STORAGE_FINALIZE_LEASE_MS,
      STORAGE_MAX_UPLOAD_BYTES: DEFAULT_STORAGE_MAX_UPLOAD_BYTES,
    });
  });

  it("has no default endpoint", () => {
    expect(parse({}).data?.STORAGE_ENDPOINT).toBeUndefined();
  });
});

describe("once storage is enabled", () => {
  it("requires a region and a bucket", () => {
    expect(issuePaths({ STORAGE_ENABLED: "true" })).toEqual([
      "STORAGE_REGION",
      "STORAGE_BUCKET",
    ]);
  });

  it("does not require an endpoint", () => {
    // Omitting it selects AWS S3's own regional endpoint, which is a real
    // deployment. MinIO and R2 need one, and its absence shows up as a
    // connection failure rather than as a silent fallback to somewhere local.
    expect(parse(enabled).success).toBe(true);
  });

  it("accepts http and https, and nothing else", () => {
    expect(
      parse({ ...enabled, STORAGE_ENDPOINT: "http://127.0.0.1:9000" }).success,
    ).toBe(true);
    expect(
      parse({ ...enabled, STORAGE_ENDPOINT: "https://s3.example.com" }).success,
    ).toBe(true);
    expect(parse({ ...enabled, STORAGE_ENDPOINT: "s3://bucket" }).success).toBe(
      false,
    );
    expect(parse({ ...enabled, STORAGE_ENDPOINT: "not a url" }).success).toBe(
      false,
    );
  });

  it("holds the bucket to the S3 naming rules", () => {
    expect(parse({ ...enabled, STORAGE_BUCKET: "ab" }).success).toBe(false);
    expect(parse({ ...enabled, STORAGE_BUCKET: "Uploads" }).success).toBe(
      false,
    );
    expect(parse({ ...enabled, STORAGE_BUCKET: "-uploads" }).success).toBe(
      false,
    );
    expect(parse({ ...enabled, STORAGE_BUCKET: "my.uploads-1" }).success).toBe(
      true,
    );
  });

  it("holds the region to a lowercase identifier", () => {
    expect(parse({ ...enabled, STORAGE_REGION: "US-EAST-1" }).success).toBe(
      false,
    );
    expect(parse({ ...enabled, STORAGE_REGION: "auto" }).success).toBe(true);
  });
});

describe("credentials", () => {
  it("accepts a complete pair", () => {
    expect(
      parse({
        ...enabled,
        STORAGE_ACCESS_KEY_ID: "an-id",
        STORAGE_SECRET_ACCESS_KEY: "a-secret",
      }).success,
    ).toBe(true);
  });

  it("accepts neither half, which selects the default credential chain", () => {
    expect(parse(enabled).success).toBe(true);
  });

  it("refuses half a pair", () => {
    // Falling back to the AWS default chain because the secret was missing
    // would silently sign requests as whichever identity the host carries.
    expect(issuePaths({ ...enabled, STORAGE_ACCESS_KEY_ID: "an-id" })).toEqual([
      "STORAGE_SECRET_ACCESS_KEY",
    ]);
    expect(
      issuePaths({ ...enabled, STORAGE_SECRET_ACCESS_KEY: "a-secret" }),
    ).toEqual(["STORAGE_ACCESS_KEY_ID"]);
  });

  it("refuses a session token on its own", () => {
    expect(
      issuePaths({ ...enabled, STORAGE_SESSION_TOKEN: "a-token" }),
    ).toEqual(["STORAGE_SESSION_TOKEN"]);
  });

  it("accepts a session token alongside a complete pair", () => {
    expect(
      parse({
        ...enabled,
        STORAGE_ACCESS_KEY_ID: "an-id",
        STORAGE_SECRET_ACCESS_KEY: "a-secret",
        STORAGE_SESSION_TOKEN: "a-token",
      }).success,
    ).toBe(true);
  });
});

describe("the numeric bounds", () => {
  it("refuses a value that is not an integer", () => {
    expect(parse({ STORAGE_CONNECT_TIMEOUT_MS: "1.5" }).success).toBe(false);
    expect(parse({ STORAGE_CONNECT_TIMEOUT_MS: "soon" }).success).toBe(false);
  });

  it("bounds each timeout at both ends", () => {
    expect(parse({ STORAGE_CONNECT_TIMEOUT_MS: "10" }).success).toBe(false);
    expect(parse({ STORAGE_CONNECT_TIMEOUT_MS: "60000" }).success).toBe(false);
    expect(parse({ STORAGE_REQUEST_TIMEOUT_MS: "10" }).success).toBe(false);
    expect(parse({ STORAGE_REQUEST_TIMEOUT_MS: "600000" }).success).toBe(false);
  });

  it("caps the upload size at what a single request can carry", () => {
    // Above this an upload would need a multipart transfer, which this platform
    // does not implement, so a larger ceiling would only produce uploads that
    // always fail at the provider.
    expect(
      parse({ STORAGE_MAX_UPLOAD_BYTES: String(MAX_STORAGE_MAX_UPLOAD_BYTES) })
        .success,
    ).toBe(true);
    expect(
      parse({
        STORAGE_MAX_UPLOAD_BYTES: String(MAX_STORAGE_MAX_UPLOAD_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(parse({ STORAGE_MAX_UPLOAD_BYTES: "0" }).success).toBe(false);
  });

  it("refuses an upload URL that outlives its intent", () => {
    expect(
      issuePaths({
        STORAGE_UPLOAD_URL_TTL_SECONDS: "900",
        STORAGE_UPLOAD_INTENT_TTL_SECONDS: "600",
      }),
    ).toEqual(["STORAGE_UPLOAD_URL_TTL_SECONDS"]);

    expect(
      parse({
        STORAGE_UPLOAD_URL_TTL_SECONDS: "600",
        STORAGE_UPLOAD_INTENT_TTL_SECONDS: "600",
      }).success,
    ).toBe(true);
  });

  it("refuses a lease that outlives its intent", () => {
    expect(
      issuePaths({
        STORAGE_UPLOAD_INTENT_TTL_SECONDS: "60",
        STORAGE_UPLOAD_URL_TTL_SECONDS: "60",
        STORAGE_FINALIZE_LEASE_MS: "60000",
      }),
    ).toEqual(["STORAGE_FINALIZE_LEASE_MS"]);
  });

  it("bounds the test run identifier", () => {
    expect(parse({ STORAGE_TEST_RUN_ID: "ci-123-1" }).success).toBe(true);
    expect(parse({ STORAGE_TEST_RUN_ID: "a/b" }).success).toBe(false);
    expect(parse({ STORAGE_TEST_RUN_ID: "a".repeat(65) }).success).toBe(false);
  });

  it("holds the key prefix to a key segment's shape", () => {
    expect(parse({ STORAGE_KEY_PREFIX: "acme.co" }).success).toBe(true);
    expect(parse({ STORAGE_KEY_PREFIX: "a/b" }).success).toBe(false);
    expect(parse({ STORAGE_KEY_PREFIX: "Acme" }).success).toBe(false);
  });
});

describe("the schema is closed", () => {
  it("refuses a variable it does not know", () => {
    expect(parse({ STORAGE_PUBLIC_READ: "true" }).success).toBe(false);
  });
});
