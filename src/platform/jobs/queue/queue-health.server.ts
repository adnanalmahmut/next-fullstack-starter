import "server-only";

import type { Redis } from "ioredis";

import { startOperationTimer } from "@/platform/observability/operation-timer.server";

import {
  getJobsRedisConfiguration,
  isJobQueueConfigured,
} from "../config/jobs-config";

import {
  closeJobsConnection,
  createProbeConnection,
  JOBS_CONNECT_TIMEOUT_MS,
} from "./connection.server";

/**
 * The queue health contract.
 *
 * It belongs to this directory rather than to the health platform for the same
 * reason the Redis and storage checks belong to theirs: this is where the queue's
 * connection is built, and a readiness check that reached for `ioredis` itself
 * would put the driver outside the one directory that is allowed to hold it — the
 * property that makes background jobs removable by deleting a folder.
 *
 * Three outcomes, and the first one is not a failure. `disabled` covers both
 * `JOBS_ENABLED=false` and a missing `JOBS_REDIS_URL`, because from a probe's
 * point of view they are the same fact: there is no queue to reach, answered from
 * configuration alone, with no client built and no name resolved. Deciding what
 * to *do* about that is the caller's job — a web process treats it as normal and
 * a worker process treats it as a misconfiguration — and this check does not
 * presume either.
 *
 * `unhealthy` carries a stable code and nothing else. Not the URL, not the host,
 * not the port, not the queue prefix, and not the driver's message: a queue
 * address is a credential, and a failing connection is precisely the moment it
 * would otherwise be printed.
 *
 * ## What it does not do
 *
 * It publishes nothing, consumes nothing, and enqueues no probe job. A health
 * check that added a message to prove the queue works would leave a message in
 * the queue every time it ran, would need a consumer that knew to discard it, and
 * would fail on a Redis whose credentials are read-only. It reads no outbox row
 * and asserts nothing about backlog depth — a queue with work waiting in it is a
 * queue that is working.
 */
export const JOBS_QUEUE_HEALTH_STATUS = {
  DISABLED: "disabled",
  HEALTHY: "healthy",
  UNHEALTHY: "unhealthy",
} as const;

export type JobsQueueHealthStatus =
  (typeof JOBS_QUEUE_HEALTH_STATUS)[keyof typeof JOBS_QUEUE_HEALTH_STATUS];

export const JOBS_REDIS_UNAVAILABLE = "JOBS_REDIS_UNAVAILABLE" as const;

export type JobsQueueHealth =
  | Readonly<{ status: typeof JOBS_QUEUE_HEALTH_STATUS.DISABLED }>
  | Readonly<{
      status: typeof JOBS_QUEUE_HEALTH_STATUS.HEALTHY;
      latencyMs: number;
    }>
  | Readonly<{
      status: typeof JOBS_QUEUE_HEALTH_STATUS.UNHEALTHY;
      code: typeof JOBS_REDIS_UNAVAILABLE;
    }>;

/** The probe is bounded by the same budget the connection is given. */
async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("The queue health check exceeded its budget."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Reports whether the queue's Redis is reachable.
 *
 * `connect()` is awaited explicitly rather than relying on the first command to
 * open the socket, because a probe wants the connection failure itself: with
 * offline queueing off, `connect()` rejects the moment the socket closes before
 * becoming ready, which is a refusal in milliseconds instead of a timeout at the
 * end of the budget.
 *
 * The connection is closed in a `finally`, on every path. A readiness command
 * that leaked a socket per invocation would be a slow leak in exactly the tool an
 * operator reaches for repeatedly during an incident.
 */
export async function checkJobsQueueHealth(): Promise<JobsQueueHealth> {
  if (!isJobQueueConfigured()) {
    return { status: JOBS_QUEUE_HEALTH_STATUS.DISABLED };
  }

  const timer = startOperationTimer();

  let connection: Redis | undefined;

  try {
    const { url } = getJobsRedisConfiguration();

    // Construction is inside the `try` because it is a real failure path: ioredis
    // parses the URL here and throws on one it cannot use. A probe that rejected
    // instead of answering would hand a raw driver error — and the address in it —
    // to a CLI that is about to print its output.
    connection = createProbeConnection(url);

    await withTimeout(async () => {
      await connection?.connect();
      await connection?.ping();
    }, JOBS_CONNECT_TIMEOUT_MS);

    return {
      status: JOBS_QUEUE_HEALTH_STATUS.HEALTHY,
      latencyMs: timer.elapsedMs(),
    };
  } catch {
    // The caught value is deliberately not read. An ioredis connection error
    // carries the address it failed to reach, and reading it here is how that
    // reaches a log line.
    return {
      status: JOBS_QUEUE_HEALTH_STATUS.UNHEALTHY,
      code: JOBS_REDIS_UNAVAILABLE,
    };
  } finally {
    if (connection) {
      await closeJobsConnection(connection);
    }
  }
}
