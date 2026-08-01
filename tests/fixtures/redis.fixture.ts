import {
  redisScopePattern,
  type RedisClientType,
  type RedisKeyScope,
} from "@/platform/redis/index.server";

/**
 * Test-side Redis helpers.
 *
 * The delete-by-prefix helper lives here rather than in the platform module on
 * purpose: production code has no reason to be able to erase a swathe of keys,
 * and giving it the ability would be giving a future bug the ability.
 *
 * `SCAN` and `UNLINK` are the only way keys are removed. `FLUSHDB` and
 * `FLUSHALL` would erase every other run sharing the server, and `KEYS` blocks
 * the server while it walks the whole key space; a contract test refuses all
 * three anywhere in the repository.
 */
const SCAN_COUNT = 100;

/**
 * Removes every key under one scope.
 *
 * The pattern is built from the scope itself, so a run can only ever delete its
 * own keys: another run's identifier is not part of this prefix and cannot be
 * matched by it.
 */
export async function deleteRedisScope(
  client: RedisClientType,
  scope: RedisKeyScope,
): Promise<number> {
  const match = redisScopePattern(scope);

  let cursor = "0";
  let deleted = 0;

  do {
    const result = await client.scan(cursor, {
      MATCH: match,
      COUNT: SCAN_COUNT,
    });

    cursor = String(result.cursor);

    if (result.keys.length > 0) {
      deleted += await client.unlink(result.keys);
    }
  } while (cursor !== "0");

  return deleted;
}

/** Every key currently stored under one scope, sorted for stable assertions. */
export async function readRedisScopeKeys(
  client: RedisClientType,
  scope: RedisKeyScope,
): Promise<string[]> {
  const match = redisScopePattern(scope);

  let cursor = "0";
  const keys: string[] = [];

  do {
    const result = await client.scan(cursor, {
      MATCH: match,
      COUNT: SCAN_COUNT,
    });

    cursor = String(result.cursor);
    keys.push(...result.keys);
  } while (cursor !== "0");

  return keys.sort();
}
