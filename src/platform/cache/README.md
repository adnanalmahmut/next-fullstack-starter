# Cache

Two caches with one identity: Next.js Cache Components for rendered output and
data, Redis cache-aside for values the application put there. Neither is a source
of truth.

## Files

| File                           | Responsibility                                              |
| ------------------------------ | ----------------------------------------------------------- |
| `cache-identity.ts`            | What a cached thing is, as a validated value.               |
| `cache-policy.ts`              | The closed set of cache-life profiles and their durations.  |
| `next-cache.server.ts`         | Declaring a lifetime and tags inside a `"use cache"` scope. |
| `cache-invalidation.ts`        | The invalidation plan a definition declares.                |
| `cache-invalidation.server.ts` | Running that plan across Next.js and Redis.                 |
| `redis-cache-aside.server.ts`  | The read-through cache and exact-key deletion.              |
| `index.server.ts`              | The controlled server-only entry point.                     |

## Usage

Caching a read with Next.js:

```ts
export async function readUser(userId: string) {
  "use cache";
  applyCachePolicy(CACHE_PROFILE.STANDARD, userCache.detail(userId));

  return userRepository.findById(userId);
}
```

Caching a value in Redis:

```ts
const user = await cacheAside({
  identity: userCache.detail(userId),
  schema: userSchema,
  ttlMs: 60_000,
  load: () => userRepository.findById(userId),
});
```

Invalidating both after a mutation:

```ts
revalidate: {
  tags: [{ identity: userCache.all() }],
  redis: [userCache.detail(userId)],
}
```

## Rules

- PostgreSQL is the source of truth. Every path where the cache cannot answer
  ends at `load`, and a `load` failure propagates rather than becoming a miss.
- A key is never a string a call site composed. It is a `CacheIdentity`, and the
  same identity produces the Next.js tag and the Redis key.
- Business vocabulary belongs to the module that owns the data. This directory
  contains no `product`, `order`, `payment`, or `user` factory.
- Anything sensitive is hashed with `opaqueCacheSegment` before it becomes a
  segment. No email address, address, session id, token, or idempotency key ever
  appears in a key or a tag.
- A profile is named, never a duration. `expire` always exceeds `revalidate`.
- The `"use cache"` directive is written at the call site and never wrapped.
- A cached value carries a version envelope and is re-validated with Zod on read.
- TTLs are mandatory and bounded; payloads are size-limited; JSON only.
- Invalidation attempts every target, reports rather than throws, and never turns
  a committed mutation into a retryable failure.
- `updateTag` is only reachable from a Server Action, and a Route Handler that
  declares it is refused when the route is defined.
- Redis entries are deleted by exact key with `UNLINK`. No pattern, no `SCAN`, no
  `KEYS`, no `FLUSHDB`, no `FLUSHALL`, no `SELECT`.
- No `unstable_cache`, no `unstable_noStore`, and no custom Next.js cache
  handler.
- A log line carries the shared control allowlist and nothing else. Never a key,
  a value, or a raw error.

The architectural policy is documented in
[`docs/architecture/cache-and-concurrency-controls.md`](../../../docs/architecture/cache-and-concurrency-controls.md).
