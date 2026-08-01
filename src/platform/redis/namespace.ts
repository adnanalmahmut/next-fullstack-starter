/**
 * The closed set of key namespaces.
 *
 * A namespace is the second-to-last part of every key and says what the key is
 * *for*, so a shared Redis instance can be reasoned about, scanned, and expired
 * per concern rather than as one flat space.
 *
 * The set is declared here and nowhere else. None of these concerns is
 * implemented yet — this change establishes the foundation only — but naming
 * them now is what stops the first cache key and the first rate-limit key from
 * being invented independently and colliding.
 */
export const REDIS_NAMESPACE = {
  CACHE: "cache",
  RATE_LIMIT: "rate-limit",
  LOCK: "lock",
  TEMPORARY: "temporary",
  IDEMPOTENCY: "idempotency",
} as const;

export type RedisNamespace =
  (typeof REDIS_NAMESPACE)[keyof typeof REDIS_NAMESPACE];

export const REDIS_NAMESPACES: readonly RedisNamespace[] =
  Object.values(REDIS_NAMESPACE);

export function isRedisNamespace(value: unknown): value is RedisNamespace {
  return (
    typeof value === "string" &&
    (REDIS_NAMESPACES as readonly string[]).includes(value)
  );
}
