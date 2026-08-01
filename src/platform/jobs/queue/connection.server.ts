import "server-only";

import { Redis, type RedisOptions } from "ioredis";

import { logJobEvent, JOB_LOG_LEVEL } from "../observability/job-logger.server";
import { JOBS_LOG_EVENT } from "../observability/log-event";

/**
 * The Redis connections BullMQ runs on.
 *
 * They are `ioredis`, and they are the only `ioredis` in the repository. The
 * cache and the concurrency controls use the `redis` package through
 * `@/platform/redis`, and the two drivers are kept apart on purpose: BullMQ
 * requires `ioredis` and mutates connection state in ways a shared client would
 * not survive — it runs blocking commands, subscribes, and expects
 * `maxRetriesPerRequest: null` on the consumer side, which is the opposite of
 * what a cache read wants.
 *
 * Nothing here connects at import. `lazyConnect` means the socket opens on the
 * first command, so importing this module in a process that never publishes and
 * never consumes costs nothing.
 *
 * A URL, a host, a username, or a password never reaches a log line. A failing
 * connection is precisely when a connection string would otherwise be printed.
 */
export const JOBS_CONNECT_TIMEOUT_MS = 5_000;

/**
 * The producer gives up quickly.
 *
 * A dispatcher publishing into a dead Redis must find out in seconds, mark the
 * row for a later attempt, and move on. `enableOfflineQueue: false` is the half
 * that matters most: with it on, `queue.add` would resolve into a buffer that is
 * discarded when the process exits, and the dispatcher would mark a row
 * published that was never published.
 */
export const PRODUCER_MAX_RETRIES_PER_REQUEST = 2;
const PRODUCER_MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 100;
const MAX_RECONNECT_DELAY_MS = 3_000;

function reconnectDelay(attempt: number): number {
  return Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** attempt,
    MAX_RECONNECT_DELAY_MS,
  );
}

/** The safe identity of a failure: a class name, never a message or an address. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "UnknownError";
}

function attachErrorListener(
  connection: Redis,
  event:
    | typeof JOBS_LOG_EVENT.QUEUE_PRODUCER_CONNECTION_FAILED
    | typeof JOBS_LOG_EVENT.QUEUE_WORKER_CONNECTION_FAILED,
): void {
  // Required, not optional: an unhandled `error` event terminates the process.
  connection.on("error", (error: unknown) => {
    logJobEvent(JOB_LOG_LEVEL.WARN, event, { errorCode: errorName(error) });
  });
}

const sharedOptions: RedisOptions = {
  connectTimeout: JOBS_CONNECT_TIMEOUT_MS,
  lazyConnect: true,
  // BullMQ builds its own key names underneath the queue prefix; a client-side
  // prefix on top of that would corrupt them.
  keyPrefix: "",
};

/**
 * The connection a `Queue` publishes through.
 *
 * Bounded everywhere: a bounded number of retries per request, a bounded number
 * of reconnects, no offline buffering, and a bounded connect timeout. The
 * dispatcher would rather be told "no" than wait.
 */
export function createProducerConnection(url: string): Redis {
  const connection = new Redis(url, {
    ...sharedOptions,
    maxRetriesPerRequest: PRODUCER_MAX_RETRIES_PER_REQUEST,
    enableOfflineQueue: false,
    retryStrategy: (attempt) =>
      attempt > PRODUCER_MAX_RECONNECT_ATTEMPTS
        ? null
        : reconnectDelay(attempt),
  });

  attachErrorListener(
    connection,
    JOBS_LOG_EVENT.QUEUE_PRODUCER_CONNECTION_FAILED,
  );

  return connection;
}

/**
 * The connection a `Worker` consumes through.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ and is right here for a
 * reason the producer's setting is not: a worker sits in a blocking read, and a
 * client-side retry limit would abandon that read during a brief Redis blip and
 * drop an in-flight job on the floor. A consumer should wait for Redis to come
 * back; a producer should not.
 */
export function createWorkerConnection(url: string): Redis {
  const connection = new Redis(url, {
    ...sharedOptions,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    retryStrategy: (attempt) => reconnectDelay(attempt),
  });

  attachErrorListener(
    connection,
    JOBS_LOG_EVENT.QUEUE_WORKER_CONNECTION_FAILED,
  );

  return connection;
}

/**
 * Closes a connection, and does not fail if it was never open.
 *
 * `quit` waits for in-flight commands; `disconnect` is the fallback for a socket
 * that is already gone, where waiting would only delay a shutdown.
 */
export async function closeJobsConnection(connection: Redis): Promise<void> {
  try {
    await connection.quit();
  } catch {
    connection.disconnect();
  }
}
