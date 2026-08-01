import "server-only";

import {
  getRedisClient,
  type RedisClientType,
} from "@/platform/redis/index.server";

/**
 * The three states a concurrency control has to tell apart.
 *
 * `disabled` and `unavailable` are the same outcome for a cache — fall back to
 * the source of truth — but they are not the same for a control. A disabled
 * Redis is a deployment that chose to run without these protections; an
 * unreachable one is an incident. A `required` caller refuses in both cases and
 * a `best-effort` caller degrades in both, but an operator needs to know which
 * of the two is happening, so the distinction is kept all the way to the log.
 */
export const REDIS_ACCESS_STATUS = {
  READY: "ready",
  DISABLED: "disabled",
  UNAVAILABLE: "unavailable",
} as const;

export type RedisAccessStatus =
  (typeof REDIS_ACCESS_STATUS)[keyof typeof REDIS_ACCESS_STATUS];

export type RedisAccess =
  | Readonly<{
      status: typeof REDIS_ACCESS_STATUS.READY;
      client: RedisClientType;
    }>
  | Readonly<{ status: typeof REDIS_ACCESS_STATUS.DISABLED }>
  | Readonly<{ status: typeof REDIS_ACCESS_STATUS.UNAVAILABLE }>;

const DISABLED: RedisAccess = { status: REDIS_ACCESS_STATUS.DISABLED };
const UNAVAILABLE: RedisAccess = { status: REDIS_ACCESS_STATUS.UNAVAILABLE };

/**
 * Resolves a client without ever throwing.
 *
 * A control decides what an absent Redis means; it should not also have to
 * decide what an exception means. Every path a caller can be in is one of the
 * three states, so a control is written as an exhaustive switch instead of a
 * `try` around business logic.
 */
export async function accessRedis(): Promise<RedisAccess> {
  try {
    const client = await getRedisClient();

    return client ? { status: REDIS_ACCESS_STATUS.READY, client } : DISABLED;
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * Runs a Lua script.
 *
 * `EVAL` rather than `EVALSHA` with a `NOSCRIPT` fallback: the fallback is a
 * branch that only executes after a server restart or a script flush, which
 * means it is the branch least likely to be exercised and most likely to be
 * wrong. Redis caches the script body after the first call regardless, and these
 * scripts are a few hundred bytes on operations that are already a round trip.
 *
 * Keys always travel in `KEYS` and values always travel in `ARGV`. No script in
 * this directory builds a key name, so a cluster can route every call correctly
 * and no value a caller supplied can ever be read as a key.
 */
export async function runRedisScript(
  client: RedisClientType,
  script: string,
  keys: readonly string[],
  args: readonly string[],
): Promise<unknown> {
  return client.eval(script, {
    keys: [...keys],
    arguments: [...args],
  });
}
