import "server-only";

import type * as z from "zod";

import {
  CONTROL_MODULE,
  CONTROL_OUTCOME,
  toControlLogFields,
  type ControlOutcome,
} from "@/platform/observability/control-log-fields";
import { getRequestLogger } from "@/platform/observability/logger.server";
import {
  buildRedisKey,
  getRedisClient,
  getRedisKeyScope,
  REDIS_NAMESPACE,
  type RedisClientType,
} from "@/platform/redis/index.server";

import { cacheKeySegments, type CacheIdentity } from "./cache-identity";
import { CACHE_LOG_EVENT, CACHE_OPERATION } from "./log-event";

/**
 * Redis cache-aside: the application reads Redis, and on a miss reads the source
 * of truth and writes what it found back.
 *
 * Two properties hold in every path below, and everything else here follows from
 * them.
 *
 * PostgreSQL is the source of truth. `load` is the authority; the cache is a
 * copy that may be absent, stale, expired, or corrupt, and every one of those
 * cases ends with `load` being called. A cached value is never the reason a
 * request succeeds.
 *
 * Redis may vanish at any moment. A disabled Redis, an unreachable Redis, a
 * failed read, and a failed write all degrade to the source of truth. The one
 * error that is *not* swallowed is `load`'s own: a database failure surfaced as
 * a cache miss would be a database failure nobody ever sees.
 */

/** The envelope every cached entry is wrapped in. */
type CacheEnvelope = Readonly<{
  /**
   * The envelope version, not the identity's.
   *
   * It changes only if the envelope itself changes shape. An entry written by an
   * older deploy is then treated as corrupt and reloaded, instead of being
   * decoded by code that expects different fields.
   */
  v: number;
  /** The cached value. `null` is a value, not an absence. */
  d: unknown;
}>;

const ENVELOPE_VERSION = 1;

/**
 * Bounds a cached entry.
 *
 * Redis is shared memory. A single oversized entry is how one feature evicts
 * every other feature's data, so the value is measured before it is written and
 * simply not cached when it is too large; the caller still gets its value.
 */
export const MAX_CACHE_VALUE_BYTES = 256 * 1024;

/**
 * Bounds a TTL.
 *
 * A TTL is mandatory: an entry with no expiry is an entry that outlives the
 * reason it was written and can only be removed by hand. The floor stops a TTL
 * so short the write is pure cost, and the ceiling stops a cache from becoming
 * an accidental store.
 */
export const MIN_CACHE_TTL_MS = 1_000;
export const MAX_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/** The largest share of a TTL that jitter may add. */
export const MAX_CACHE_TTL_JITTER_RATIO = 0.5;

export type CacheAsideOptions<TValue> = Readonly<{
  identity: CacheIdentity;
  /**
   * The shape a cached entry must still satisfy to be used.
   *
   * Re-validating on read is what makes a deploy safe: an entry written by the
   * previous shape fails the schema and is reloaded, rather than being handed to
   * code that trusts a type the data no longer has.
   */
  schema: z.ZodType<TValue>;
  ttlMs: number;
  /** The source of truth. Usually a repository call. Its failures propagate. */
  load: () => TValue | Promise<TValue>;
  /**
   * Spreads expiry times so entries written together do not expire together.
   *
   * Defaults to none, so a caller that has not thought about it gets
   * deterministic behaviour rather than a surprise.
   */
  jitterRatio?: number;
}>;

function assertTtl(ttlMs: number): void {
  if (
    !Number.isInteger(ttlMs) ||
    ttlMs < MIN_CACHE_TTL_MS ||
    ttlMs > MAX_CACHE_TTL_MS
  ) {
    throw new Error("The cache TTL is not acceptable.");
  }
}

function assertJitterRatio(ratio: number): void {
  if (
    !Number.isFinite(ratio) ||
    ratio < 0 ||
    ratio > MAX_CACHE_TTL_JITTER_RATIO
  ) {
    throw new Error("The cache TTL jitter ratio is not acceptable.");
  }
}

/**
 * The effective TTL for one write.
 *
 * `Math.random` is deliberate: this is load spreading, not a security decision,
 * and nothing about the entry can be predicted from its expiry time. The result
 * is clamped so jitter can never push a TTL past the ceiling.
 */
export function jitteredTtlMs(ttlMs: number, jitterRatio: number): number {
  if (jitterRatio === 0) {
    return ttlMs;
  }

  const span = Math.floor(ttlMs * jitterRatio);

  return Math.min(
    ttlMs + Math.floor(Math.random() * (span + 1)),
    MAX_CACHE_TTL_MS,
  );
}

/** The Redis key an identity occupies. Built here and nowhere else. */
export function redisCacheKey(identity: CacheIdentity): string {
  return buildRedisKey(
    getRedisKeyScope(),
    REDIS_NAMESPACE.CACHE,
    ...cacheKeySegments(identity),
  );
}

function logCache(
  event: string,
  outcome?: ControlOutcome,
  ttlMs?: number,
): void {
  const fields = toControlLogFields({
    module: CONTROL_MODULE.CACHE,
    operation: CACHE_OPERATION.ASIDE,
    ...(outcome === undefined ? {} : { outcome }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });

  // A hit and a miss are the normal shape of a working cache. Recording them at
  // `info` would add a line to every read of every request; the levels here keep
  // the default output to the cases an operator would act on.
  if (event === CACHE_LOG_EVENT.WRITE_FAILED) {
    getRequestLogger().warn(fields, event);

    return;
  }

  getRequestLogger().debug(fields, event);
}

/**
 * The client, or `null` when Redis cannot serve this read.
 *
 * A disabled Redis and an unreachable Redis are different facts and are logged
 * as such, but they lead to the same place: the source of truth.
 */
async function clientForCache(): Promise<RedisClientType | null> {
  try {
    const client = await getRedisClient();

    if (!client) {
      logCache(CACHE_LOG_EVENT.BYPASSED, CONTROL_OUTCOME.DISABLED);

      return null;
    }

    return client;
  } catch {
    logCache(CACHE_LOG_EVENT.BYPASSED, CONTROL_OUTCOME.UNAVAILABLE);

    return null;
  }
}

/**
 * Decodes a stored entry.
 *
 * Anything that is not a current, schema-valid envelope is corrupt: unparseable
 * JSON, a foreign shape, an old envelope version, or a value the schema no
 * longer accepts. All four are the same decision — reload — so they answer with
 * the same `undefined`.
 */
function decodeEnvelope<TValue>(
  raw: string,
  schema: z.ZodType<TValue>,
): { value: TValue } | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as CacheEnvelope).v !== ENVELOPE_VERSION ||
    !("d" in parsed)
  ) {
    return undefined;
  }

  const result = schema.safeParse((parsed as CacheEnvelope).d);

  return result.success ? { value: result.data } : undefined;
}

/** Removes an entry that could not be decoded. Best effort, by design. */
async function discard(client: RedisClientType, key: string): Promise<void> {
  try {
    await client.unlink(key);
  } catch {
    // The entry is unreadable either way, and it has a TTL. Failing to remove it
    // must not turn a successful read into a failed one.
  }
}

async function writeEntry<TValue>(
  client: RedisClientType,
  key: string,
  value: TValue,
  ttlMs: number,
): Promise<void> {
  const envelope: CacheEnvelope = { v: ENVELOPE_VERSION, d: value };

  let payload: string;

  try {
    // JSON only. A serializer that can reconstruct arbitrary objects turns a
    // cache entry into a code path, and a Redis anyone can write to into remote
    // code execution.
    payload = JSON.stringify(envelope);
  } catch {
    logCache(CACHE_LOG_EVENT.WRITE_FAILED, CONTROL_OUTCOME.CORRUPT);

    return;
  }

  if (Buffer.byteLength(payload, "utf8") > MAX_CACHE_VALUE_BYTES) {
    logCache(CACHE_LOG_EVENT.WRITE_FAILED, CONTROL_OUTCOME.OVERSIZED);

    return;
  }

  try {
    await client.set(key, payload, {
      expiration: { type: "PX", value: ttlMs },
    });
  } catch {
    logCache(CACHE_LOG_EVENT.WRITE_FAILED, CONTROL_OUTCOME.UNAVAILABLE);
  }
}

/**
 * Reads through the cache, falling back to the source of truth.
 *
 * The order is fixed: reject an unusable TTL, resolve a client, read, decode,
 * and only then load and write. Every failure that is not `load`'s own ends in
 * the same place, so a caller writes one call and gets the same value whether
 * Redis is fast, slow, broken, or absent.
 */
export async function cacheAside<TValue>(
  options: CacheAsideOptions<TValue>,
): Promise<TValue> {
  const jitterRatio = options.jitterRatio ?? 0;

  assertTtl(options.ttlMs);
  assertJitterRatio(jitterRatio);

  const client = await clientForCache();

  if (!client) {
    return options.load();
  }

  const key = redisCacheKey(options.identity);

  let raw: string | null = null;

  try {
    raw = await client.get(key);
  } catch {
    logCache(CACHE_LOG_EVENT.BYPASSED, CONTROL_OUTCOME.UNAVAILABLE);

    return options.load();
  }

  if (raw !== null) {
    const decoded = decodeEnvelope(raw, options.schema);

    if (decoded) {
      logCache(CACHE_LOG_EVENT.HIT);

      return decoded.value;
    }

    logCache(CACHE_LOG_EVENT.MISS, CONTROL_OUTCOME.CORRUPT);
    await discard(client, key);
  } else {
    logCache(CACHE_LOG_EVENT.MISS);
  }

  // `load` runs outside the try blocks above: its failure is the application's
  // failure and must reach the caller unchanged.
  const value = await options.load();
  const ttlMs = jitteredTtlMs(options.ttlMs, jitterRatio);

  await writeEntry(client, key, value, ttlMs);

  return value;
}

/**
 * Deletes exact cache entries.
 *
 * `UNLINK` rather than `DEL`: reclaiming the memory on a background thread keeps
 * a large entry from blocking the server on a mutation path. Only the keys the
 * identities name are removed — there is no pattern, no prefix, and no scan.
 *
 * Answers the number of entries removed, or `null` when Redis is not serving, so
 * the caller can tell "nothing to delete" from "could not delete".
 */
export async function invalidateRedisCache(
  identities: readonly CacheIdentity[],
): Promise<number | null> {
  if (identities.length === 0) {
    return 0;
  }

  const client = await clientForCache();

  if (!client) {
    return null;
  }

  const keys = identities.map((identity) => redisCacheKey(identity));

  return client.unlink(keys);
}
