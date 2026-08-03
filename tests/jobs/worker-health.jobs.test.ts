import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkDatabaseHealth,
  database,
} from "@/platform/database/index.server";
import {
  checkWorkerReadiness,
  DISABLED_DEPENDENCY,
  HEALTH_CODE,
  HEALTHY_DEPENDENCY,
  unhealthyDependency,
  WORKER_READINESS_STATUS,
  type DependencyReport,
} from "@/platform/health/index.server";
import {
  checkJobsQueueHealth,
  isJobQueueConfigured,
  isJobsEnabled,
  JOBS_QUEUE_HEALTH_STATUS,
  resetJobsConfiguration,
} from "@/platform/jobs/index.server";

import { configureJobsForTest, waitFor } from "../fixtures/jobs.fixture";

/**
 * Worker readiness against a real queue, a real database, and the real command.
 *
 * Three things are proved here that cannot be proved anywhere else.
 *
 * The queue probe against a real Redis: whether `connect()` followed by `PING` on
 * a non-retrying connection actually reports a refusal in milliseconds rather than
 * timing out at the end of its budget is a fact about `ioredis`, not about this
 * repository's belief.
 *
 * The connections it leaves behind: a one-shot probe that leaked a socket per
 * invocation would be a slow leak in the exact tool an operator runs repeatedly
 * during an incident, and only a real server can show that.
 *
 * The exit codes of `pnpm jobs:health`: the mapping from a verdict to `0`, `1`, or
 * `78` lives in a process entry point, which no unit test can exercise without
 * becoming the process. Running the command is the only honest way to cover it —
 * and it also proves the command writes nothing to a terminal that a structured
 * logger would have redacted.
 */
const COMMAND_TIMEOUT_MS = 90_000;

configureJobsForTest();

const queueUrl = process.env.JOBS_REDIS_URL ?? "redis://127.0.0.1:6379";
const databaseUrl = process.env.DATABASE_URL ?? "";

/** A port nothing listens on, so a refusal is immediate and no server is disturbed. */
const closedQueueUrl = "redis://127.0.0.1:6399";

type CommandResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;

/**
 * Runs `pnpm jobs:health` as its own process.
 *
 * The environment is built explicitly rather than inherited, so a variable this
 * suite set for its own use cannot leak into a case that is meant to be missing
 * one.
 */
function runHealthCommand(
  overrides: Record<string, string | undefined>,
): Promise<CommandResult> {
  const environment: NodeJS.ProcessEnv = { ...process.env };

  for (const name of Object.keys(environment)) {
    if (name.startsWith("JOBS_")) {
      delete environment[name];
    }
  }

  environment.APP_ENV = "test";
  environment.DATABASE_URL = databaseUrl;

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete environment[name];
    } else {
      environment[name] = value;
    }
  }

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn("pnpm", ["jobs:health"], {
      cwd: process.cwd(),
      env: environment,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code: number | null) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function socketCount(): number {
  return process
    .getActiveResourcesInfo()
    .filter(
      (resource) => resource.includes("TCP") || resource.includes("Socket"),
    ).length;
}

beforeAll(() => {
  expect(process.env.APP_ENV).toBe("test");
  expect(isJobsEnabled()).toBe(true);
  expect(isJobQueueConfigured()).toBe(true);
  expect(databaseUrl).not.toBe("");

  const url = new URL(queueUrl);

  expect(["127.0.0.1", "localhost", "::1", "redis"]).toContain(url.hostname);
});

afterAll(async () => {
  configureJobsForTest();
  await database.$disconnect();
});

describe("the queue probe", () => {
  it("reports healthy against the real queue Redis", async () => {
    const health = await checkJobsQueueHealth();

    expect(health.status).toBe(JOBS_QUEUE_HEALTH_STATUS.HEALTHY);

    if (health.status === JOBS_QUEUE_HEALTH_STATUS.HEALTHY) {
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(health.latencyMs).toBeLessThan(5_000);
    }
  });

  it("reports unhealthy for a port nothing listens on, quickly", async () => {
    process.env.JOBS_REDIS_URL = closedQueueUrl;
    resetJobsConfiguration();

    const startedAt = performance.now();
    const health = await checkJobsQueueHealth();
    const elapsed = performance.now() - startedAt;

    process.env.JOBS_REDIS_URL = queueUrl;
    resetJobsConfiguration();

    expect(health).toEqual({
      status: JOBS_QUEUE_HEALTH_STATUS.UNHEALTHY,
      code: HEALTH_CODE.JOBS_REDIS_UNAVAILABLE,
    });

    // The whole reason a probe uses a non-retrying connection: a refusal must
    // arrive in milliseconds, not at the end of the connect budget.
    expect(elapsed).toBeLessThan(3_000);
  });

  it("reports disabled when the flag is off, without touching Redis", async () => {
    process.env.JOBS_ENABLED = "false";
    resetJobsConfiguration();

    const health = await checkJobsQueueHealth();

    configureJobsForTest();

    expect(health).toEqual({ status: JOBS_QUEUE_HEALTH_STATUS.DISABLED });
  });

  it("carries no address into a failure", async () => {
    process.env.JOBS_REDIS_URL = "redis://someone:hunter2@127.0.0.1:6399";
    resetJobsConfiguration();

    const health = await checkJobsQueueHealth();

    process.env.JOBS_REDIS_URL = queueUrl;
    resetJobsConfiguration();

    const serialized = JSON.stringify(health);

    for (const forbidden of ["hunter2", "someone", "redis://", "6399"]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("leaves no connection open after repeated probes", async () => {
    const before = socketCount();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await checkJobsQueueHealth();
    }

    // Sockets close asynchronously, so this waits for the count to settle rather
    // than sampling it once. A probe that leaked one per call would never settle.
    await waitFor(
      "the socket count to return to its starting value",
      async () => socketCount() <= before,
    );

    expect(socketCount()).toBeLessThanOrEqual(before);
  });
});

describe("the worker readiness contract", () => {
  async function databaseReport(): Promise<DependencyReport> {
    const health = await checkDatabaseHealth();

    return health.status === "healthy"
      ? HEALTHY_DEPENDENCY
      : unhealthyDependency(HEALTH_CODE.DATABASE_UNAVAILABLE);
  }

  async function queueReport(): Promise<DependencyReport> {
    const health = await checkJobsQueueHealth();

    if (health.status === JOBS_QUEUE_HEALTH_STATUS.HEALTHY) {
      return HEALTHY_DEPENDENCY;
    }

    return health.status === JOBS_QUEUE_HEALTH_STATUS.DISABLED
      ? DISABLED_DEPENDENCY
      : unhealthyDependency(HEALTH_CODE.JOBS_REDIS_UNAVAILABLE);
  }

  it("is ready with a real database and a real queue", async () => {
    await expect(
      checkWorkerReadiness({
        jobsEnabled: isJobsEnabled(),
        queueConfigured: isJobQueueConfigured(),
        checkDatabase: databaseReport,
        checkQueue: queueReport,
      }),
    ).resolves.toEqual({
      process: "worker",
      status: WORKER_READINESS_STATUS.READY,
      code: HEALTH_CODE.WORKER_READY,
      databaseStatus: "healthy",
      queueStatus: "healthy",
    });
  });

  it("is not ready when the queue is unreachable", async () => {
    process.env.JOBS_REDIS_URL = closedQueueUrl;
    resetJobsConfiguration();

    const report = await checkWorkerReadiness({
      jobsEnabled: isJobsEnabled(),
      queueConfigured: isJobQueueConfigured(),
      checkDatabase: databaseReport,
      checkQueue: queueReport,
    });

    process.env.JOBS_REDIS_URL = queueUrl;
    resetJobsConfiguration();

    expect(report.status).toBe(WORKER_READINESS_STATUS.NOT_READY);
    expect(report.code).toBe(HEALTH_CODE.WORKER_NOT_READY);
    expect(report.queueStatus).toBe("unhealthy");
    expect(report.databaseStatus).toBe("healthy");
  });

  it("is misconfigured when jobs are off, and opens nothing", async () => {
    process.env.JOBS_ENABLED = "false";
    resetJobsConfiguration();

    const before = socketCount();
    const report = await checkWorkerReadiness({
      jobsEnabled: isJobsEnabled(),
      queueConfigured: isJobQueueConfigured(),
      checkDatabase: databaseReport,
      checkQueue: queueReport,
    });

    configureJobsForTest();

    expect(report.status).toBe(WORKER_READINESS_STATUS.MISCONFIGURED);
    expect(report.code).toBe(HEALTH_CODE.WORKER_MISCONFIGURED);
    expect(socketCount()).toBeLessThanOrEqual(before);
  });

  it("writes no outbox row and creates no receipt", async () => {
    const [outboxBefore, receiptsBefore] = await Promise.all([
      database.outboxMessage.count(),
      database.jobExecutionReceipt.count(),
    ]);

    await checkWorkerReadiness({
      jobsEnabled: isJobsEnabled(),
      queueConfigured: isJobQueueConfigured(),
      checkDatabase: databaseReport,
      checkQueue: queueReport,
    });

    const [outboxAfter, receiptsAfter] = await Promise.all([
      database.outboxMessage.count(),
      database.jobExecutionReceipt.count(),
    ]);

    expect(outboxAfter).toBe(outboxBefore);
    expect(receiptsAfter).toBe(receiptsBefore);
  });
});

describe("pnpm jobs:health", () => {
  it(
    "exits 0 when the worker is ready",
    async () => {
      const result = await runHealthCommand({
        JOBS_ENABLED: "true",
        JOBS_REDIS_URL: queueUrl,
      });

      expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    },
    COMMAND_TIMEOUT_MS,
  );

  it(
    "exits non-zero and recoverable when the queue is unreachable",
    async () => {
      const result = await runHealthCommand({
        JOBS_ENABLED: "true",
        JOBS_REDIS_URL: closedQueueUrl,
      });

      // `1` and not `78`: the deployment is correct and something is down, so a
      // supervisor should keep trying.
      expect(result.code).toBe(1);
    },
    COMMAND_TIMEOUT_MS,
  );

  it(
    "exits 78 when jobs are switched off in a worker deployment",
    async () => {
      const result = await runHealthCommand({
        JOBS_ENABLED: "false",
        JOBS_REDIS_URL: queueUrl,
      });

      // Distinct from `1` on purpose: this will never start until somebody changes
      // a variable, and a supervisor should stop restarting it in a tight loop.
      expect(result.code).toBe(78);
    },
    COMMAND_TIMEOUT_MS,
  );

  it(
    "exits 78 when no queue address is set",
    async () => {
      const result = await runHealthCommand({
        JOBS_ENABLED: "true",
        JOBS_REDIS_URL: undefined,
      });

      expect(result.code).toBe(78);
    },
    COMMAND_TIMEOUT_MS,
  );

  it(
    "prints nothing that a structured logger would have redacted",
    async () => {
      const result = await runHealthCommand({
        JOBS_ENABLED: "true",
        JOBS_REDIS_URL: "redis://someone:hunter2@127.0.0.1:6399",
      });

      const output = `${result.stdout}${result.stderr}`;

      // The command uses the structured logger and no `console`, so a credential
      // cannot reach a terminal — which is where it would be copied into an issue.
      for (const forbidden of [
        "hunter2",
        "someone",
        "redis://",
        "postgresql://",
        databaseUrl,
      ].filter((value) => value.length > 0)) {
        expect(output, forbidden).not.toContain(forbidden);
      }
    },
    COMMAND_TIMEOUT_MS,
  );

  it(
    "opens no HTTP port",
    async () => {
      const result = await runHealthCommand({
        JOBS_ENABLED: "true",
        JOBS_REDIS_URL: queueUrl,
      });

      // It is a one-shot command that exits. A worker that listened would need a
      // service, an ingress, and a second unauthenticated surface.
      expect(result.code).toBe(0);

      const output = `${result.stdout}${result.stderr}`.toLowerCase();

      for (const forbidden of ["listening", "server started", "0.0.0.0:"]) {
        expect(output, forbidden).not.toContain(forbidden);
      }
    },
    COMMAND_TIMEOUT_MS,
  );
});
