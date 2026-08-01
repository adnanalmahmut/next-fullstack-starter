# Cache and concurrency controls

Two platform areas — `src/platform/cache` and `src/platform/concurrency` — and one
rule that governs both.

## PostgreSQL is the source of truth

Nothing in these two directories decides whether something is true. They make
true things cheaper to read and less likely to be done twice.

| Store         | Holds                                                                              | Losing it costs      |
| ------------- | ---------------------------------------------------------------------------------- | -------------------- |
| PostgreSQL    | Durable state, transactions, unique constraints, authorization                     | The data             |
| Redis         | Cached copies, rate counters, short-lived idempotency records, coordination leases | Speed and smoothness |
| Next.js Cache | Rendered output and data, invalidated by tag                                       | Speed                |

Redis is never a substitute for:

- a database transaction;
- a unique constraint;
- optimistic or pessimistic locking on a row;
- a durable ledger;
- a financial idempotency record;
- an outbox.

If correctness depends on something happening exactly once, that has to be
enforced where the data lives — inside the transaction that writes it — because
that is the only place where the guarantee and the write either both happen or
neither does.

## Two caches, deliberately separate

**Next.js Cache Components** cache the _output_ of a function or component, keyed
by its arguments, in the Next.js cache. Opt in with `"use cache"`.

**Redis cache-aside** caches a _value_ the application put there and read back.
Opt in by calling `cacheAside`.

They share an identity, so one declaration invalidates both. They are not one
storage implementation: there is no custom Next.js cache handler and Next.js
never writes into Redis. Merging them would mean one key derivation, one
invalidation path, and one failure mode for two very different things.

`unstable_cache` and `unstable_noStore` are not used. An ESLint rule refuses
them: a second cache with its own key derivation would mean two answers to "is
this stale?".

## Cache-life profiles

Three profiles, defined once in `src/platform/cache/cache-policy.ts` and consumed
by `next.config.ts`:

| Profile    | stale | revalidate | expire |
| ---------- | ----- | ---------- | ------ |
| `frequent` | 30s   | 30s        | 5m     |
| `standard` | 5m    | 5m         | 1h     |
| `durable`  | 1h    | 1h         | 1d     |

`expire` must exceed `revalidate`; a profile that expired before it revalidated
would turn every background refresh into a blocking miss. A unit test asserts it
against the real definitions.

A module names a profile; it never writes a duration. `applyCachePolicy` takes a
`CacheProfile`, so a typo is a compile error rather than a silent fallback to the
default profile:

```ts
export async function readUser(userId: string) {
  "use cache";
  applyCachePolicy(CACHE_PROFILE.STANDARD, userCache.detail(userId));

  return userRepository.findById(userId);
}
```

The `"use cache"` directive is written at the call site and is never wrapped.
Next.js resolves it statically, so a helper that hid it would produce a function
that looks cached and is not.

## Module-owned key factories

A cache identity is a value, not a string:

```ts
type CacheIdentity = Readonly<{
  module: string;
  resource: string;
  version: number;
  segments: readonly string[];
}>;
```

`createCacheIdentity` validates the module name, the resource name, the version,
each segment, the segment count, and the resulting tag length. The same identity
produces a Next.js tag (`identity:user:v1:user-1`) and a Redis key
(`<prefix>:<env>:cache:identity:user:v1:user-1`), so the two key spaces cannot
drift.

`version` is the deploy-safety mechanism. Increment it when the cached shape
changes and old entries become unreachable instead of being decoded as the new
shape.

**The platform owns no business vocabulary.** `product`, `order`, `payment`, and
`user` are named by the module that owns the data:

```ts
export const userCache = {
  all: () =>
    createCacheIdentity({
      module: "identity",
      resource: "user",
      version: 1,
      segments: [],
    }),
  detail: (userId: string) =>
    createCacheIdentity({
      module: "identity",
      resource: "user",
      version: 1,
      segments: [userId],
    }),
};
```

Anything sensitive is hashed first. An email address, an IP address, a session
id, a token, or an idempotency key must never appear raw in a key or a tag:

```ts
segments: [opaqueCacheSegment(email)];
```

## Cache-aside

```ts
const user = await cacheAside({
  identity: userCache.detail(userId),
  schema: userSchema,
  ttlMs: 60_000,
  load: () => userRepository.findById(userId),
});
```

| Situation                 | Behaviour                                             |
| ------------------------- | ----------------------------------------------------- |
| Redis disabled            | `load()`, no client created                           |
| Redis unreachable         | Sanitized bypass line, then `load()`                  |
| Hit                       | Decode, re-validate with Zod, return                  |
| Miss, expired, or corrupt | `load()`, write with a TTL, return                    |
| `load()` throws           | Propagates — a database failure is never a cache miss |

Everything else follows from those two columns:

- The value is wrapped in a version envelope and re-validated on read, so an
  entry written by a previous deploy fails the schema and is reloaded.
- A corrupt entry is removed best-effort and reloaded.
- `null` is a value, distinct from a miss.
- A TTL is mandatory and bounded; optional jitter spreads expiry times.
- The payload is size-limited before it is written.
- JSON only. A serializer that can reconstruct arbitrary objects turns a cache
  entry into a code path.
- No rejected promise and no raw error is ever cached.

## Invalidation

One system, in `src/platform/cache/cache-invalidation.server.ts`, shared by
`defineAction` and `defineRoute`. A plan is declared statically and can never
come from client input:

```ts
revalidate: {
  paths: [{ path: "/admin/users" }],
  tags: [{ identity: userCache.all() }],
  redis: [userCache.detail(userId)],
}
```

Two tag strategies, because they are two different promises to the user:

| Strategy                 | API                         | Available in   | Next read               |
| ------------------------ | --------------------------- | -------------- | ----------------------- |
| `read-your-own-writes`   | `updateTag`                 | Server Actions | Waits for fresh data    |
| `stale-while-revalidate` | `revalidateTag(tag, "max")` | Both           | Serves stale, refreshes |

`updateTag` is a Server Action API. A Route Handler that declares
`read-your-own-writes` is refused when the route is _defined_ — at module load —
rather than in the post-success step where the mutation has already committed and
the only possible response is a logged warning.

Redis entries are deleted by exact key with `UNLINK`. There is no pattern, no
prefix, and no scan on a mutation path.

**Failure behaviour.** After the mutation commits, every target is attempted
independently. One failure does not cancel the rest, each failure is logged with
a safe error code, and the success response stands. A completed mutation is never
turned into a response a client would retry.

The consequence is a window of stale reads, bounded by the profile's `expire`.
There is no transaction spanning PostgreSQL, Redis, and the Next.js cache, and
nothing here pretends otherwise.

## Rate limiting

A fixed-window limiter, atomic in one Lua script:

```lua
local count = redis.call('INCRBY', KEYS[1], cost)
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], windowMs); ttl = windowMs end
```

`INCRBY` followed by a separate `PEXPIRE` has a real race: two callers can both
increment before either sets the expiry, and a crash between the two leaves a
counter that never resets and an endpoint refused forever.

Keys travel in `KEYS`, values in `ARGV`, and no key is built inside Lua. The
subject is hashed before it becomes part of the key and is never logged.

Known cost of a fixed window: a caller may spend its budget at the end of one
window and again at the start of the next, so the short-term burst is up to twice
the limit. That is acceptable for a protection layer. An over-limit request still
increments, so a client that keeps hammering keeps its own window full.

The result is a four-member union — `allowed`, `limited`, `disabled`,
`unavailable` — so a caller cannot mistake "no limiter ran" for "the limiter said
yes".

| Route adapter outcome            | Response                           |
| -------------------------------- | ---------------------------------- |
| `limited`                        | `RATE_LIMITED`, 429, `Retry-After` |
| `unavailable` + fallback `allow` | The request proceeds               |
| `unavailable` + fallback `deny`  | `DEPENDENCY_UNAVAILABLE`, 503      |

`Retry-After` is written by the factory from a number the hook returned. A hook
returns a decision and never a `Response`, a status, or a header.

## Idempotency

A lifecycle, not a lookup. A lookup separate from its completion leaves a window
in which a retry finds nothing and runs the operation twice.

```
begin   → acquired | replay | conflict | disabled | unavailable
complete → settled | lost | unavailable
abort    → settled | lost | unavailable
```

`begin` claims the key with `SET NX PX` before the use case runs and hands back a
reservation carrying `complete` and `abort`. The claim, the owner token, and the
TTLs stay inside that closure: there is no shared map and nothing outlives the
request.

**Scope.** A key is scoped by route name, API version, the authorized actor (or an
explicit public subject), and the hashed client key. The raw `Idempotency-Key` is
read only in the route adapter, is hashed, and is never stored or logged.

**Fingerprint.** A deterministic digest of the method, route, validated params,
validated query, validated body, and actor. Built from the _validated_ input, so
two byte-different bodies that parse to the same request are the same request.
Never logged.

| Stored state                   | Answer     |
| ------------------------------ | ---------- |
| Nothing                        | `acquired` |
| `processing`, any fingerprint  | `conflict` |
| `completed`, same fingerprint  | `replay`   |
| `completed`, other fingerprint | `conflict` |
| Unreadable or outdated record  | `conflict` |

A replayed output is re-validated against the route's schema; a stored value that
no longer satisfies today's contract is a conflict, not a replay. Completion and
abort are guarded by the owner token in Lua, so a request that stalled past its
TTL cannot overwrite the record of the request that replaced it.

**The crash window.** This is not atomic with a PostgreSQL mutation. A crash
between the database commit and `complete` leaves a record in `processing` until
its TTL expires: a retry inside that window is refused with a conflict, and a
retry after it runs the operation again. For a financial or otherwise
non-repeatable operation the idempotency record belongs in PostgreSQL, inside the
same transaction as the mutation.

`best-effort` is never acceptable for a financial operation or for anything that
cannot tolerate being performed twice.

## Locks

A single-Redis lease lock: `SET key <random token> NX PX leaseMs`, released with
an atomic compare-and-delete, optionally extended with an atomic
compare-and-`PEXPIRE`.

What it is for: keeping several instances from doing the same avoidable work at
once — one instance rebuilding a report, one draining a queue, one sending a
digest.

What it is not:

- Not a substitute for a database constraint or a transaction.
- Not protection for a financial invariant on its own.
- Not Redlock. There is one Redis, so a failover that loses recent writes can
  hand the same lease to two owners.
- Not bounded by the callback. Work that outlives its lease is no longer
  protected, and the next caller is entitled to the lock.

Guarantees that do hold: the token is cryptographically random; only the owner
can release; a lease always has a TTL; waiting is bounded by a deadline; retries
are delayed with jitter; the callback runs at most once; release happens in
`finally`; a release failure is logged and never replaces the callback's own
error.

`acquireLock` answers `acquired`, `contended`, `timeout`, `disabled`, or
`unavailable`. `withLock` answers `executed`, `contended`, or `timeout`, and
applies the declared policy to the last two states.

## The fallback matrix

There is no implicit default anywhere. Every use names its own answer.

| Capability  | Disabled or unavailable                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Cache       | Bypass to PostgreSQL. Always. Not configurable, because a cache has an authoritative answer available by definition |
| Rate limit  | Explicit `allow` or `deny` — availability or protection                                                             |
| Idempotency | Explicit `required` (503) or `best-effort` (run unprotected)                                                        |
| Lock        | Explicit `required` (503) or `best-effort` (run unprotected)                                                        |

## Route Handler order

```
request context
  → rate limit
  → validation
  → authentication
  → authorization
  → idempotency begin (replay / conflict)
  → beforeExecute
  → use case
  → idempotency complete
  → afterSuccess
  → cache invalidation
  → audit
  → response
```

On a failure before the commit: idempotency abort → `afterFailure` → safe
response.

The last four steps all run after the mutation has committed and none can be
rolled back, so their order is deliberate:

- **Completion first.** It is the only post-success step whose absence changes
  what a _client_ observes on a retry, so it runs closest to the commit.
- **Invalidation before audit.** Invalidation is what the next reader sees; audit
  is what an operator reads later.
- **Audit last.** It is the step most likely to grow, and growth there must not
  delay the two steps that affect correctness.

Each is isolated. An observer failure never turns a committed mutation into a
retryable response.

## Server Actions

`defineAction` uses the same invalidation system, so an Action and a Route Handler
purge the same tags through the same code.

No Action gets rate limiting, idempotency, or a lock automatically. The typed
adapters exist and an Action definition may reach for them, but a control that
applied itself to every Action would be a control nobody chose.

## Architecture boundaries

Enforced by ESLint and by `tests/contract/cache-concurrency-controls.contract.test.ts`:

- The `redis` driver is imported only inside `src/platform/redis`.
- `cache` and `concurrency` reach Redis only through
  `@/platform/redis/index.server`.
- Neither control module imports Prisma, `pg`, or `@/platform/database`.
- Repositories, the authorization area, the proxy, and module `domain` and
  `application` layers import neither control.
- No use case receives a Redis client; no route or Action context carries one.
- The cache platform contains no business key factory.
- No `KEYS`, `FLUSHDB`, `FLUSHALL`, or `SELECT`; no `SCAN` on a production path.
- No `unstable_cache`, no `unstable_noStore`, no custom Next.js cache handler.
- No existing business route depends on Redis.

## What this change does not do

No business cache, no cached authorization decision, no cached session, no
Redis-only financial idempotency, no database-backed idempotency table, no
Redlock, no Cluster, no Sentinel, no queue, no BullMQ, no Pub/Sub, no Streams, no
websocket coordination, no custom cache handler, no metrics backend, and no new
business endpoint.

## Removing Redis

The Next.js side survives on its own: profiles, `applyCachePolicy`, tags, path and
tag invalidation all work without Redis. Removing Redis deletes
`src/platform/cache/redis-cache-aside.server.ts`, the whole of
`src/platform/concurrency`, and the `redis` field from any invalidation plan.
`defineRoute` and `defineAction` stay. See
[`redis-foundation.md`](./redis-foundation.md#removing-redis-from-a-generated-project)
for the full procedure.
