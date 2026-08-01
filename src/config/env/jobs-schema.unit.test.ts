import { describe, expect, it } from "vitest";

import {
  DEFAULT_JOBS_QUEUE_PREFIX,
  DEFAULT_JOBS_WORKER_CONCURRENCY,
  DEFAULT_OUTBOX_BATCH_SIZE,
  jobsEnvironmentSchema,
  MAX_JOBS_WORKER_CONCURRENCY,
  MAX_OUTBOX_BATCH_SIZE,
  MIN_OUTBOX_POLL_INTERVAL_MS,
  serverEnvironmentSchema,
} from "./schema";

describe("the jobs environment defaults to off", () => {
  it("accepts an environment with no jobs variable at all", () => {
    const result = jobsEnvironmentSchema.safeParse({});

    expect(result.success).toBe(true);
    expect(result.data?.JOBS_ENABLED).toBe(false);
    expect(result.data?.JOBS_REDIS_URL).toBeUndefined();
  });

  it("supplies a bounded value for every setting", () => {
    const values = jobsEnvironmentSchema.parse({});

    expect(values.JOBS_QUEUE_PREFIX).toBe(DEFAULT_JOBS_QUEUE_PREFIX);
    expect(values.JOBS_WORKER_CONCURRENCY).toBe(
      DEFAULT_JOBS_WORKER_CONCURRENCY,
    );
    expect(values.OUTBOX_BATCH_SIZE).toBe(DEFAULT_OUTBOX_BATCH_SIZE);
    expect(values.OUTBOX_LEASE_MS).toBeGreaterThan(
      values.OUTBOX_POLL_INTERVAL_MS,
    );
  });

  it("reads only the two literal spellings of the flag", () => {
    expect(
      jobsEnvironmentSchema.parse({ JOBS_ENABLED: "true" }).JOBS_ENABLED,
    ).toBe(true);
    expect(
      jobsEnvironmentSchema.parse({ JOBS_ENABLED: "false" }).JOBS_ENABLED,
    ).toBe(false);

    // "1", "yes", and "TRUE" are the spellings that make a deployment think it
    // enabled something it did not.
    for (const value of ["1", "yes", "TRUE", "on"]) {
      expect(
        jobsEnvironmentSchema.safeParse({ JOBS_ENABLED: value }).success,
        value,
      ).toBe(false);
    }
  });

  it("is absent from the required server environment", () => {
    const shape = Object.keys(serverEnvironmentSchema.shape);

    expect(shape.some((name) => name.startsWith("JOBS"))).toBe(false);
    expect(shape.some((name) => name.startsWith("OUTBOX"))).toBe(false);
  });
});

describe("the queue address", () => {
  it("is never required, even with jobs enabled", () => {
    // This is the whole point of the two-level split: an application with jobs
    // on can still record work while Redis and the worker are down.
    const result = jobsEnvironmentSchema.safeParse({ JOBS_ENABLED: "true" });

    expect(result.success).toBe(true);
    expect(result.data?.JOBS_REDIS_URL).toBeUndefined();
  });

  it("accepts only the two Redis protocols", () => {
    for (const url of [
      "redis://127.0.0.1:6379",
      "rediss://queue.example:6380",
    ]) {
      expect(
        jobsEnvironmentSchema.safeParse({ JOBS_REDIS_URL: url }).success,
        url,
      ).toBe(true);
    }

    for (const url of [
      "http://127.0.0.1:6379",
      "postgresql://127.0.0.1:5432/db",
      "127.0.0.1:6379",
      "amqp://127.0.0.1",
    ]) {
      expect(
        jobsEnvironmentSchema.safeParse({ JOBS_REDIS_URL: url }).success,
        url,
      ).toBe(false);
    }
  });

  it("has no default and no localhost fallback", () => {
    expect(jobsEnvironmentSchema.parse({}).JOBS_REDIS_URL).toBeUndefined();
  });
});

describe("every number is bounded on both ends", () => {
  it.each([
    { name: "JOBS_WORKER_CONCURRENCY", tooSmall: "0", tooLarge: "1000" },
    {
      name: "JOBS_WORKER_SHUTDOWN_TIMEOUT_MS",
      tooSmall: "10",
      tooLarge: "999999",
    },
    { name: "OUTBOX_BATCH_SIZE", tooSmall: "0", tooLarge: "10000" },
    { name: "OUTBOX_POLL_INTERVAL_MS", tooSmall: "1", tooLarge: "999999" },
    { name: "OUTBOX_LEASE_MS", tooSmall: "10", tooLarge: "9999999" },
    { name: "OUTBOX_MAX_PUBLISH_ATTEMPTS", tooSmall: "0", tooLarge: "1000" },
    { name: "OUTBOX_BACKOFF_BASE_MS", tooSmall: "1", tooLarge: "999999" },
  ])("refuses $name outside its range", ({ name, tooSmall, tooLarge }) => {
    expect(jobsEnvironmentSchema.safeParse({ [name]: tooSmall }).success).toBe(
      false,
    );
    expect(jobsEnvironmentSchema.safeParse({ [name]: tooLarge }).success).toBe(
      false,
    );
  });

  it("refuses a fractional count", () => {
    expect(
      jobsEnvironmentSchema.safeParse({ JOBS_WORKER_CONCURRENCY: "2.5" })
        .success,
    ).toBe(false);
  });

  it("accepts the boundaries themselves", () => {
    const values = jobsEnvironmentSchema.parse({
      JOBS_WORKER_CONCURRENCY: String(MAX_JOBS_WORKER_CONCURRENCY),
      OUTBOX_BATCH_SIZE: String(MAX_OUTBOX_BATCH_SIZE),
      OUTBOX_POLL_INTERVAL_MS: String(MIN_OUTBOX_POLL_INTERVAL_MS),
    });

    expect(values.JOBS_WORKER_CONCURRENCY).toBe(MAX_JOBS_WORKER_CONCURRENCY);
    expect(values.OUTBOX_BATCH_SIZE).toBe(MAX_OUTBOX_BATCH_SIZE);
  });

  it("requires the lease to outlast the poll interval", () => {
    // A lease shorter than the interval lets a second dispatcher claim a row the
    // first one is still publishing.
    const result = jobsEnvironmentSchema.safeParse({
      OUTBOX_POLL_INTERVAL_MS: "5000",
      OUTBOX_LEASE_MS: "5000",
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("OUTBOX_LEASE_MS");
  });
});

describe("the queue prefix", () => {
  it("accepts a key-shaped value", () => {
    expect(
      jobsEnvironmentSchema.parse({ JOBS_QUEUE_PREFIX: "acme-jobs.eu-west" })
        .JOBS_QUEUE_PREFIX,
    ).toBe("acme-jobs.eu-west");
  });

  it.each(["Acme", "acme jobs", "acme:jobs", "-acme", "", "acme*"])(
    "refuses %j",
    (prefix) => {
      expect(
        jobsEnvironmentSchema.safeParse({ JOBS_QUEUE_PREFIX: prefix }).success,
      ).toBe(false);
    },
  );
});

describe("unknown variables", () => {
  it("are refused rather than ignored", () => {
    // A typo in a deployment's variable name is a silent misconfiguration
    // otherwise: the value is dropped and the default applies.
    expect(
      jobsEnvironmentSchema.safeParse({ JOBS_ENABLD: "true" }).success,
    ).toBe(false);
  });
});
