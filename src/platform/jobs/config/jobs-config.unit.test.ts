import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_JOBS_QUEUE_PREFIX } from "@/config/env/schema";

import {
  getJobsConfiguration,
  getJobsRedisConfiguration,
  isJobQueueConfigured,
  isJobsEnabled,
  resetJobsConfiguration,
} from "./jobs-config";

const OWNED_VARIABLES = [
  "JOBS_ENABLED",
  "JOBS_REDIS_URL",
  "JOBS_QUEUE_PREFIX",
  "JOBS_WORKER_CONCURRENCY",
  "JOBS_WORKER_SHUTDOWN_TIMEOUT_MS",
  "OUTBOX_BATCH_SIZE",
  "OUTBOX_POLL_INTERVAL_MS",
  "OUTBOX_LEASE_MS",
  "OUTBOX_MAX_PUBLISH_ATTEMPTS",
  "OUTBOX_BACKOFF_BASE_MS",
  "JOBS_TEST_RUN_ID",
] as const;

const original = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of OWNED_VARIABLES) {
    original.set(name, process.env[name]);
    delete process.env[name];
  }

  resetJobsConfiguration();
});

afterEach(() => {
  for (const [name, value] of original) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  original.clear();
  resetJobsConfiguration();
});

describe("jobs are off unless asked for", () => {
  it("reports disabled with no variable set", () => {
    expect(isJobsEnabled()).toBe(false);
    expect(isJobQueueConfigured()).toBe(false);
  });

  it("still answers every other setting", () => {
    // A disabled configuration is a complete configuration, not a stub: code
    // that reads a batch size should not have to know whether jobs are on.
    const configuration = getJobsConfiguration();

    expect(configuration.outbox.batchSize).toBeGreaterThan(0);
    expect(configuration.workerConcurrency).toBeGreaterThan(0);
  });

  it("turns on with the flag alone, with no queue address", () => {
    process.env.JOBS_ENABLED = "true";

    expect(isJobsEnabled()).toBe(true);
    // Recording work needs the flag; reaching a queue needs the address. This
    // is what lets the application keep writing an outbox while Redis is down.
    expect(isJobQueueConfigured()).toBe(false);
  });
});

describe("the queue address is required only where a queue is built", () => {
  it("refuses to answer when jobs are disabled", () => {
    process.env.JOBS_REDIS_URL = "redis://127.0.0.1:6379";

    expect(() => getJobsRedisConfiguration()).toThrow(/not enabled/);
  });

  it("refuses to answer when the address is missing", () => {
    process.env.JOBS_ENABLED = "true";

    expect(() => getJobsRedisConfiguration()).toThrow(/JOBS_REDIS_URL/);
  });

  it("never puts the address in the failure message", () => {
    process.env.JOBS_ENABLED = "true";
    process.env.JOBS_REDIS_URL = "redis://127.0.0.1:6379";
    resetJobsConfiguration();

    expect(getJobsRedisConfiguration().url).toBe("redis://127.0.0.1:6379");

    delete process.env.JOBS_REDIS_URL;
    resetJobsConfiguration();

    try {
      getJobsRedisConfiguration();
      expect.unreachable("A missing address must be refused.");
    } catch (error) {
      expect(String(error)).not.toContain("127.0.0.1");
    }
  });

  it("answers with the address and the prefix once both are present", () => {
    process.env.JOBS_ENABLED = "true";
    process.env.JOBS_REDIS_URL = "rediss://queue.example:6380";

    const configuration = getJobsRedisConfiguration();

    expect(configuration.url).toBe("rediss://queue.example:6380");
    expect(configuration.queuePrefix).toBe(getJobsConfiguration().queuePrefix);
    expect(isJobQueueConfigured()).toBe(true);
  });
});

describe("the queue prefix", () => {
  it("scopes a test run so two runs cannot consume each other's jobs", () => {
    process.env.JOBS_TEST_RUN_ID = "ci-1234-1";

    const { queuePrefix } = getJobsConfiguration();

    expect(queuePrefix).toBe(`${DEFAULT_JOBS_QUEUE_PREFIX}:test:ci-1234-1`);
  });

  it("generates a run identifier when the runner supplies none", () => {
    const { queuePrefix } = getJobsConfiguration();

    expect(
      queuePrefix.startsWith(`${DEFAULT_JOBS_QUEUE_PREFIX}:test:run-`),
    ).toBe(true);
  });

  it("adds the separators itself so a value cannot widen its own scope", () => {
    process.env.JOBS_QUEUE_PREFIX = "acme-jobs";
    process.env.JOBS_TEST_RUN_ID = "ci-1";

    expect(getJobsConfiguration().queuePrefix).toBe("acme-jobs:test:ci-1");
  });
});

describe("resolution is lazy and memoized", () => {
  it("reads the environment once", () => {
    process.env.JOBS_ENABLED = "true";

    expect(isJobsEnabled()).toBe(true);

    // A process reads one configuration for its lifetime. Changing a variable
    // afterwards must not change the answer, or two call sites in one request
    // could disagree.
    process.env.JOBS_ENABLED = "false";

    expect(isJobsEnabled()).toBe(true);
  });

  it("re-reads only after an explicit reset", () => {
    expect(isJobsEnabled()).toBe(false);

    process.env.JOBS_ENABLED = "true";
    resetJobsConfiguration();

    expect(isJobsEnabled()).toBe(true);
  });

  it("keeps one generated run identifier across calls", () => {
    expect(getJobsConfiguration().queuePrefix).toBe(
      getJobsConfiguration().queuePrefix,
    );
  });
});
