import { readRedisEnvironment } from "@/config/env/read-redis";
import { serverEnv } from "@/config/env/index.server";
import type { RedisEnvironment } from "@/config/env/schema";

import type { RedisKeyScope } from "./key";

/**
 * The resolved Redis configuration, read lazily.
 *
 * Nothing here runs at import time. A module that imports this file does not
 * read the environment, does not validate a URL, and certainly does not open a
 * socket; all of that waits for the first call. That is what makes Redis
 * genuinely optional rather than optional-in-principle.
 *
 * The type is a discriminated union so a caller that has checked `enabled`
 * gets the URL without a non-null assertion, and a caller that has not cannot
 * reach it at all.
 */
export type RedisConfiguration =
  | Readonly<{
      enabled: false;
      keyPrefix: string;
      connectTimeoutMs: number;
    }>
  | Readonly<{
      enabled: true;
      url: string;
      keyPrefix: string;
      connectTimeoutMs: number;
    }>;

function toConfiguration(environment: RedisEnvironment): RedisConfiguration {
  const shared = {
    keyPrefix: environment.REDIS_KEY_PREFIX,
    connectTimeoutMs: environment.REDIS_CONNECT_TIMEOUT_MS,
  };

  // `REDIS_URL` is guaranteed by the schema once the flag is on; the check is
  // repeated here so the narrowing is established by code rather than asserted.
  if (!environment.REDIS_ENABLED || environment.REDIS_URL === undefined) {
    return { enabled: false, ...shared };
  }

  return { enabled: true, url: environment.REDIS_URL, ...shared };
}

type RedisState = {
  configuration?: RedisConfiguration;
  keyScope?: RedisKeyScope;
};

/**
 * Memoized per process, and held on `globalThis` for the same reason the Prisma
 * client is: a development reload re-evaluates the module, and a second scope
 * would give the reloaded code a different key space from the keys already
 * written.
 */
const globalForRedisConfig = globalThis as typeof globalThis & {
  redisConfigurationState?: RedisState;
};

function state(): RedisState {
  globalForRedisConfig.redisConfigurationState ??= {};

  return globalForRedisConfig.redisConfigurationState;
}

export function getRedisConfiguration(): RedisConfiguration {
  const current = state();

  current.configuration ??= toConfiguration(readRedisEnvironment());

  return current.configuration;
}

/** `true` only when Redis is explicitly enabled. Never opens a connection. */
export function isRedisEnabled(): boolean {
  return getRedisConfiguration().enabled;
}

/**
 * The key scope of this process.
 *
 * Under test a run identifier is always present: one is taken from
 * `REDIS_TEST_RUN_ID` when the runner supplies it, and generated otherwise, so
 * two runs against the same Redis can never see each other's keys even when
 * nobody remembered to set a variable.
 */
export function getRedisKeyScope(): RedisKeyScope {
  const current = state();

  if (current.keyScope) {
    return current.keyScope;
  }

  const environment = readRedisEnvironment();
  const appEnvironment = serverEnv.APP_ENV;

  const scope: RedisKeyScope =
    appEnvironment === "test"
      ? {
          prefix: environment.REDIS_KEY_PREFIX,
          environment: appEnvironment,
          testRunId: environment.REDIS_TEST_RUN_ID ?? generateTestRunId(),
          ...(environment.REDIS_TEST_WORKER_ID === undefined
            ? {}
            : { testWorkerId: environment.REDIS_TEST_WORKER_ID }),
        }
      : {
          prefix: environment.REDIS_KEY_PREFIX,
          environment: appEnvironment,
        };

  current.keyScope = scope;

  return scope;
}

function generateTestRunId(): string {
  return `run-${crypto.randomUUID()}`;
}

/**
 * Drops the memoized configuration.
 *
 * Exported for tests that change the environment between cases, and for nothing
 * else: application code reads one configuration for the lifetime of a process.
 */
export function resetRedisConfiguration(): void {
  delete globalForRedisConfig.redisConfigurationState;
}
