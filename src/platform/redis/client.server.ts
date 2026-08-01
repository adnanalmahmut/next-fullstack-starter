import "server-only";

import { createClient, type RedisClientType } from "redis";

import { logger } from "@/platform/observability/logger.server";

import { getRedisConfiguration } from "./config";

/**
 * The lazy, server-only Redis client.
 *
 * Nothing connects at import time and nothing connects at startup. The first
 * caller that actually needs Redis opens the socket; a process that never calls
 * one of these functions never talks to Redis at all. That is the whole point:
 * the application has to run, build, and pass its suite with no Redis anywhere,
 * so the connection has to be a consequence of use rather than of loading a
 * module.
 */

/**
 * Stable log event names for the Redis connection.
 *
 * A Redis log line carries an event name and, at most, the constructor name of
 * a failure. It never carries the URL, the host, the username, the password, or
 * the raw error: a connection string is a credential, and a failing connection
 * is exactly when it would otherwise be printed.
 */
export const REDIS_LOG_EVENT = {
  CONNECTED: "redis.connected",
  CONNECTION_FAILED: "redis.connection.failed",
  CLIENT_ERROR: "redis.client.error",
  CLOSED: "redis.closed",
} as const;

export type RedisLogEvent =
  (typeof REDIS_LOG_EVENT)[keyof typeof REDIS_LOG_EVENT];

/**
 * A bounded reconnect policy.
 *
 * An unbounded retry loop is worse than a failure: a request, a test, or a
 * build would hang instead of being told that Redis is unavailable. After a few
 * short attempts the client gives up, and the next call starts a fresh attempt.
 */
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 100;
const MAX_RECONNECT_DELAY_MS = 1_000;

type RedisClientState = {
  client?: RedisClientType;
  connection?: Promise<RedisClientType>;
};

/**
 * Held on `globalThis` so a development reload reuses the open connection
 * instead of leaking one per reload, and so the `error` listener is attached
 * once per client rather than once per module evaluation.
 */
const globalForRedis = globalThis as typeof globalThis & {
  redisClientState?: RedisClientState;
};

function state(): RedisClientState {
  globalForRedis.redisClientState ??= {};

  return globalForRedis.redisClientState;
}

/** The safe identity of a failure: a class name, never a message or an address. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "UnknownError";
}

function createRedisClient(url: string, connectTimeoutMs: number) {
  const client = createClient({
    url,
    socket: {
      connectTimeout: connectTimeoutMs,
      reconnectStrategy: (retries: number) =>
        retries >= MAX_RECONNECT_ATTEMPTS
          ? false
          : Math.min(
              RECONNECT_BASE_DELAY_MS * 2 ** retries,
              MAX_RECONNECT_DELAY_MS,
            ),
    },
  }) as RedisClientType;

  // Required, not optional: an unhandled `error` event terminates the process.
  // It is attached to the one client instance, so a reload cannot stack
  // listeners on top of each other.
  client.on("error", (error: unknown) => {
    logger.error({ errorName: errorName(error) }, REDIS_LOG_EVENT.CLIENT_ERROR);
  });

  return client;
}

/**
 * Opens the connection, or joins the one already being opened.
 *
 * Concurrent callers share a single promise, so ten simultaneous first uses
 * open one socket. A failed attempt clears that promise before rejecting: a
 * cached rejection would poison every later call for the lifetime of the
 * process, turning one unreachable moment into a permanently broken Redis.
 */
async function connect(
  url: string,
  connectTimeoutMs: number,
): Promise<RedisClientType> {
  const current = state();

  if (current.client?.isReady) {
    return current.client;
  }

  current.connection ??= (async () => {
    const client = current.client ?? createRedisClient(url, connectTimeoutMs);

    current.client = client;

    try {
      if (!client.isOpen) {
        await client.connect();
      }

      logger.info({}, REDIS_LOG_EVENT.CONNECTED);

      return client;
    } catch (error) {
      logger.error(
        { errorName: errorName(error) },
        REDIS_LOG_EVENT.CONNECTION_FAILED,
      );

      // The half-open client is discarded with the promise, so the next call
      // builds a clean one instead of reusing a socket that never came up.
      current.client = undefined;

      try {
        client.destroy();
      } catch {
        // The client never came up; there is nothing left to release.
      }

      throw new Error("Redis is unavailable.");
    } finally {
      current.connection = undefined;
    }
  })();

  return current.connection;
}

/** `true` only when Redis is explicitly enabled. Never opens a connection. */
export { isRedisEnabled } from "./config";

/**
 * The connected client, or `null` when Redis is disabled.
 *
 * `null` means "not configured", and nothing else. An enabled Redis that cannot
 * be reached rejects instead, because answering `null` there would let a caller
 * treat an outage as a deliberate absence and silently skip work.
 */
export async function getRedisClient(): Promise<RedisClientType | null> {
  const configuration = getRedisConfiguration();

  if (!configuration.enabled) {
    return null;
  }

  return connect(configuration.url, configuration.connectTimeoutMs);
}

/** The connected client. Fails when Redis is disabled or unreachable. */
export async function requireRedisClient(): Promise<RedisClientType> {
  const client = await getRedisClient();

  if (!client) {
    throw new Error("Redis is not enabled.");
  }

  return client;
}

/**
 * Closes the connection and forgets the client.
 *
 * For tests and for an explicit shutdown. No signal handler is registered here:
 * a platform module that installed one would be deciding the process's shutdown
 * behaviour on behalf of every host that ever imports it.
 */
export async function closeRedisClient(): Promise<void> {
  const current = state();
  const client = current.client;

  current.client = undefined;
  current.connection = undefined;

  if (!client) {
    return;
  }

  try {
    if (client.isOpen) {
      await client.close();
    }
  } catch {
    client.destroy();
  }

  logger.info({}, REDIS_LOG_EVENT.CLOSED);
}
