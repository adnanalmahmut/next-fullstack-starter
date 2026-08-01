import { parseEnvironment } from "./parse";
import { redisEnvironmentSchema, type RedisEnvironment } from "./schema";

/**
 * The variables this reader looks up, named for documentation. The index
 * signature is what lets `process.env` be passed directly: none of these names
 * is declared on `ProcessEnv`, so a purely optional shape would be rejected as
 * having nothing in common with it.
 */
type RedisEnvironmentSource = Readonly<Record<string, string | undefined>> & {
  readonly REDIS_ENABLED?: string;
  readonly REDIS_URL?: string;
  readonly REDIS_KEY_PREFIX?: string;
  readonly REDIS_CONNECT_TIMEOUT_MS?: string;
  readonly REDIS_TEST_RUN_ID?: string;
  readonly REDIS_TEST_WORKER_ID?: string;
  readonly VITEST_WORKER_ID?: string;
};

/**
 * Reads the optional Redis configuration.
 *
 * Unlike the server and database readers this one is never called at import
 * time. `index.server.ts` does not export a `redisEnv`, because doing so would
 * make Redis part of startup validation and a project that never enables it
 * would still be paying for it. The Redis platform module reads this lazily, on
 * first use.
 *
 * A source with no Redis variable at all is valid and yields a disabled
 * configuration.
 */
export function readRedisEnvironment(
  source: RedisEnvironmentSource = process.env,
): RedisEnvironment {
  return parseEnvironment("redis", redisEnvironmentSchema, {
    ...(source.REDIS_ENABLED === undefined
      ? {}
      : { REDIS_ENABLED: source.REDIS_ENABLED }),
    ...(source.REDIS_URL === undefined ? {} : { REDIS_URL: source.REDIS_URL }),
    ...(source.REDIS_KEY_PREFIX === undefined
      ? {}
      : { REDIS_KEY_PREFIX: source.REDIS_KEY_PREFIX }),
    ...(source.REDIS_CONNECT_TIMEOUT_MS === undefined
      ? {}
      : { REDIS_CONNECT_TIMEOUT_MS: source.REDIS_CONNECT_TIMEOUT_MS }),
    ...(source.REDIS_TEST_RUN_ID === undefined
      ? {}
      : { REDIS_TEST_RUN_ID: source.REDIS_TEST_RUN_ID }),
    // The test runner's worker identifier is accepted as a fallback so a
    // parallel suite gets a distinct key space without every project having to
    // export a second variable.
    ...(() => {
      const workerId = source.REDIS_TEST_WORKER_ID ?? source.VITEST_WORKER_ID;

      return workerId === undefined ? {} : { REDIS_TEST_WORKER_ID: workerId };
    })(),
  });
}
