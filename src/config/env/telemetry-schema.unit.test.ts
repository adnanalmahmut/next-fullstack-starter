import { describe, expect, it } from "vitest";

import {
  DEFAULT_TELEMETRY_EXPORT_TIMEOUT_MS,
  DEFAULT_TELEMETRY_METRIC_EXPORT_INTERVAL_MS,
  MAX_APP_RELEASE_LENGTH,
  MAX_TELEMETRY_EXPORT_TIMEOUT_MS,
  MAX_TELEMETRY_METRIC_EXPORT_INTERVAL_MS,
  MAX_TELEMETRY_TRACE_SAMPLE_RATIO,
  MIN_TELEMETRY_EXPORT_TIMEOUT_MS,
  MIN_TELEMETRY_METRIC_EXPORT_INTERVAL_MS,
  MIN_TELEMETRY_TRACE_SAMPLE_RATIO,
  telemetryEnvironmentSchema,
} from "./schema";

const ENDPOINT = "https://collector.example.com:4318";

function parse(values: Record<string, string>) {
  return telemetryEnvironmentSchema.safeParse(values);
}

describe("the disabled default", () => {
  it("accepts an environment with no telemetry variable at all", () => {
    const result = parse({});

    expect(result.success).toBe(true);
    expect(result.data?.TELEMETRY_ENABLED).toBe(false);
  });

  it("requires no endpoint while telemetry is off", () => {
    expect(parse({ TELEMETRY_ENABLED: "false" }).success).toBe(true);
  });

  it("applies the documented bounded defaults", () => {
    const result = parse({});

    expect(result.data?.TELEMETRY_METRIC_EXPORT_INTERVAL_MS).toBe(
      DEFAULT_TELEMETRY_METRIC_EXPORT_INTERVAL_MS,
    );
    expect(result.data?.TELEMETRY_EXPORT_TIMEOUT_MS).toBe(
      DEFAULT_TELEMETRY_EXPORT_TIMEOUT_MS,
    );
    // Undefined rather than a number, so the environment-specific default is
    // chosen where `APP_ENV` is known.
    expect(result.data?.TELEMETRY_TRACE_SAMPLE_RATIO).toBeUndefined();
  });

  it("refuses a flag that is neither true nor false", () => {
    expect(parse({ TELEMETRY_ENABLED: "yes" }).success).toBe(false);
  });

  it("refuses an unknown telemetry variable", () => {
    expect(parse({ TELEMETRY_SAMPLE_EVERYTHING: "true" }).success).toBe(false);
  });
});

describe("the enabled contract", () => {
  it("requires an endpoint", () => {
    const result = parse({ TELEMETRY_ENABLED: "true" });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["TELEMETRY_OTLP_ENDPOINT"]);
  });

  it("accepts an endpoint and nothing else", () => {
    const result = parse({
      TELEMETRY_ENABLED: "true",
      TELEMETRY_OTLP_ENDPOINT: ENDPOINT,
    });

    expect(result.success).toBe(true);
    expect(result.data?.TELEMETRY_OTLP_ENDPOINT).toBe(ENDPOINT);
  });

  it.each([
    { name: "http", value: "http://127.0.0.1:4318", accepted: true },
    { name: "https", value: ENDPOINT, accepted: true },
    { name: "grpc", value: "grpc://collector:4317", accepted: false },
    { name: "a bare host", value: "collector:4318", accepted: false },
    { name: "a file URL", value: "file:///tmp/collector", accepted: false },
  ])("$name endpoint is accepted: $accepted", ({ value, accepted }) => {
    expect(
      parse({
        TELEMETRY_ENABLED: "true",
        TELEMETRY_OTLP_ENDPOINT: value,
      }).success,
    ).toBe(accepted);
  });

  it.each([
    "https://user@collector.example.com:4318",
    "https://user:secret@collector.example.com:4318",
    "https://:secret@collector.example.com:4318",
  ])("refuses credentials embedded in the endpoint: %s", (value) => {
    const result = parse({
      TELEMETRY_ENABLED: "true",
      TELEMETRY_OTLP_ENDPOINT: value,
    });

    expect(result.success).toBe(false);
    // The refusal names the shape and the alternative; it never echoes the value,
    // because the value contains a credential.
    const message = result.error?.issues
      .map((issue) => issue.message)
      .join(" ");

    expect(message).toContain("TELEMETRY_OTLP_HEADERS");
    expect(message).not.toContain("secret");
  });
});

describe("bounded numbers", () => {
  it.each([
    { value: String(MIN_TELEMETRY_TRACE_SAMPLE_RATIO), accepted: true },
    { value: "0.1", accepted: true },
    { value: String(MAX_TELEMETRY_TRACE_SAMPLE_RATIO), accepted: true },
    { value: "-0.1", accepted: false },
    { value: "1.1", accepted: false },
    { value: "many", accepted: false },
  ])("sample ratio $value is accepted: $accepted", ({ value, accepted }) => {
    expect(
      parse({
        TELEMETRY_ENABLED: "true",
        TELEMETRY_OTLP_ENDPOINT: ENDPOINT,
        TELEMETRY_TRACE_SAMPLE_RATIO: value,
      }).success,
    ).toBe(accepted);
  });

  it.each([
    { value: String(MIN_TELEMETRY_METRIC_EXPORT_INTERVAL_MS), accepted: true },
    { value: String(MAX_TELEMETRY_METRIC_EXPORT_INTERVAL_MS), accepted: true },
    {
      value: String(MIN_TELEMETRY_METRIC_EXPORT_INTERVAL_MS - 1),
      accepted: false,
    },
    {
      value: String(MAX_TELEMETRY_METRIC_EXPORT_INTERVAL_MS + 1),
      accepted: false,
    },
    { value: "0", accepted: false },
    { value: "-1000", accepted: false },
  ])("export interval $value is accepted: $accepted", ({ value, accepted }) => {
    expect(
      parse({
        TELEMETRY_ENABLED: "true",
        TELEMETRY_OTLP_ENDPOINT: ENDPOINT,
        TELEMETRY_METRIC_EXPORT_INTERVAL_MS: value,
        // The floor, so this case tests the interval's own bounds rather than the
        // cross-field rule that a timeout must fit inside the interval.
        TELEMETRY_EXPORT_TIMEOUT_MS: String(MIN_TELEMETRY_EXPORT_TIMEOUT_MS),
      }).success,
    ).toBe(accepted);
  });

  it.each([
    { value: String(MIN_TELEMETRY_EXPORT_TIMEOUT_MS), accepted: true },
    { value: String(MAX_TELEMETRY_EXPORT_TIMEOUT_MS), accepted: true },
    { value: String(MIN_TELEMETRY_EXPORT_TIMEOUT_MS - 1), accepted: false },
    { value: String(MAX_TELEMETRY_EXPORT_TIMEOUT_MS + 1), accepted: false },
    { value: "0", accepted: false },
  ])("export timeout $value is accepted: $accepted", ({ value, accepted }) => {
    expect(
      parse({
        TELEMETRY_ENABLED: "true",
        TELEMETRY_OTLP_ENDPOINT: ENDPOINT,
        TELEMETRY_METRIC_EXPORT_INTERVAL_MS: String(
          MAX_TELEMETRY_METRIC_EXPORT_INTERVAL_MS,
        ),
        TELEMETRY_EXPORT_TIMEOUT_MS: value,
      }).success,
    ).toBe(accepted);
  });

  it("refuses a timeout longer than the collection interval", () => {
    // An export still running when the next collection begins is a combination the
    // SDK refuses outright, so it is named here rather than thrown at startup.
    const result = parse({
      TELEMETRY_ENABLED: "true",
      TELEMETRY_OTLP_ENDPOINT: ENDPOINT,
      TELEMETRY_METRIC_EXPORT_INTERVAL_MS: "1000",
      TELEMETRY_EXPORT_TIMEOUT_MS: "5000",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([
      "TELEMETRY_EXPORT_TIMEOUT_MS",
    ]);
  });

  it("accepts a timeout equal to the collection interval", () => {
    expect(
      parse({
        TELEMETRY_ENABLED: "true",
        TELEMETRY_OTLP_ENDPOINT: ENDPOINT,
        TELEMETRY_METRIC_EXPORT_INTERVAL_MS: "5000",
        TELEMETRY_EXPORT_TIMEOUT_MS: "5000",
      }).success,
    ).toBe(true);
  });

  it("keeps the two documented defaults compatible with each other", () => {
    const result = parse({
      TELEMETRY_ENABLED: "true",
      TELEMETRY_OTLP_ENDPOINT: ENDPOINT,
    });

    expect(result.success).toBe(true);
    expect(result.data?.TELEMETRY_EXPORT_TIMEOUT_MS ?? 0).toBeLessThanOrEqual(
      result.data?.TELEMETRY_METRIC_EXPORT_INTERVAL_MS ?? 0,
    );
  });
});

describe("the release identifier", () => {
  it.each([
    { value: "1.4.2", accepted: true },
    { value: "2026.08.03-a1b2c3d", accepted: true },
    { value: "v1.0.0+build.7", accepted: true },
    { value: "r".repeat(MAX_APP_RELEASE_LENGTH), accepted: true },
    { value: "r".repeat(MAX_APP_RELEASE_LENGTH + 1), accepted: false },
    { value: "", accepted: false },
    { value: "release with spaces", accepted: false },
    { value: "-leading-dash", accepted: false },
  ])("release $value is accepted: $accepted", ({ value, accepted }) => {
    expect(parse({ APP_RELEASE: value }).success).toBe(accepted);
  });

  it("is optional, so a deployment with no release still boots", () => {
    expect(parse({}).data?.APP_RELEASE).toBeUndefined();
  });
});

describe("the header credential", () => {
  it("accepts a bounded list", () => {
    const result = parse({
      TELEMETRY_ENABLED: "true",
      TELEMETRY_OTLP_ENDPOINT: ENDPOINT,
      TELEMETRY_OTLP_HEADERS: "authorization=Bearer-token",
    });

    expect(result.success).toBe(true);
  });

  it("refuses a malformed list without echoing it", () => {
    const secret = "super-secret-token";
    const result = parse({
      TELEMETRY_ENABLED: "true",
      TELEMETRY_OTLP_ENDPOINT: ENDPOINT,
      TELEMETRY_OTLP_HEADERS: `authorization=Bearer ${secret}`,
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(secret);
  });
});
