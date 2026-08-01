import "server-only";

/**
 * The controlled server-only entry point for Redis.
 *
 * Application code imports Redis from here and never from the `redis` package:
 * an ESLint boundary and a contract test keep the driver inside this directory,
 * so removing Redis from a generated project is a matter of deleting this
 * directory rather than hunting for imports.
 *
 * Importing this module opens no connection.
 */
export type { RedisClientType } from "redis";

export {
  closeRedisClient,
  getRedisClient,
  isRedisEnabled,
  requireRedisClient,
  REDIS_LOG_EVENT,
  type RedisLogEvent,
} from "./client.server";

export {
  getRedisConfiguration,
  getRedisKeyScope,
  resetRedisConfiguration,
  type RedisConfiguration,
} from "./config";

export {
  checkRedisHealth,
  REDIS_HEALTH_STATUS,
  REDIS_UNAVAILABLE,
  type RedisHealth,
} from "./health.server";

export {
  buildRedisKey,
  isValidRedisKeySegment,
  redisNamespacePattern,
  redisScopePattern,
  redisScopePrefix,
  REDIS_KEY_SEPARATOR,
  type RedisKeyScope,
} from "./key";

export {
  isRedisNamespace,
  REDIS_NAMESPACE,
  REDIS_NAMESPACES,
  type RedisNamespace,
} from "./namespace";
