# Redis Foundation

Redis is available to this project and required by none of it.

The application boots, builds, serves, and passes its whole default suite on a
machine where Redis is not installed and no Redis variable is set. Enabling it is
a deployment decision, and removing it is a matter of deleting one directory and
a handful of adjacent files. Nothing in `auth`, `database`, `actions`, the Route
Handler factory, the proxy, observability, localization, or the UI knows Redis
exists.

This change establishes the foundation only: a configuration, a connection, a
health contract, and a key discipline. No cache, no rate limiter, no lock, and no
idempotency store is built on it yet.

## Optionality

| Situation                | Behaviour                                                        |
| ------------------------ | ---------------------------------------------------------------- |
| No Redis variable at all | Disabled. No client, no socket, no validation failure.           |
| `REDIS_ENABLED=false`    | Disabled, even if `REDIS_URL` is present.                        |
| `REDIS_ENABLED=true`     | `REDIS_URL` becomes required. The connection opens on first use. |

Three rules hold this in place:

- Redis configuration is **not** part of `serverEnvironmentSchema` and is **not**
  exported from `src/config/env/index.server.ts`. Startup never reads it, so a
  missing `REDIS_URL` cannot fail validation the way a missing `DATABASE_URL`
  does.
- Nothing connects at import time. Importing `@/platform/redis/index.server`
  opens no socket; the first call that actually needs Redis does.
- There is no default URL and no `localhost` fallback in production code. An
  enabled Redis with no address is a configuration mistake, and guessing at one
  would turn a deployment error into a silent connection to the wrong server.

`pnpm verify` and the end-to-end suite run with Redis off, in CI as well as
locally. That is not incidental — it is the test of the claim.

## When to use Redis

Reach for it when the state is **shared between processes** and **losing it is
acceptable**:

- a cache in front of an expensive read;
- a rate-limit counter that must be the same for every instance;
- a short-lived lock coordinating one job across replicas;
- a temporary value with a natural expiry, such as a one-time token;
- an idempotency record for a mutation that may be retried.

## When not to use Redis

- **As a source of truth.** It is an eviction-capable, memory-first store. PostgreSQL
  owns durable state.
- **For a session.** Sessions are database-backed and validated server-side on
  every read; moving them to Redis would trade a revocable session for a fast one.
- **For a durable queue.** A queue needs delivery guarantees and a worker
  lifecycle. That is a separate decision with its own ADR.
- **For anything a single process can hold.** A per-request memo or a module-level
  constant does not need a network round trip.
- **As a way to avoid a schema change.** A cache in front of a missing index hides
  a problem rather than fixing it.

## Enabling Redis locally

Redis runs as its own Compose project, so its lifecycle is independent of
PostgreSQL: `pnpm db:up` never starts it and `pnpm redis:down` never stops the
database.

```bash
cp compose.redis.env.example compose.redis.env

pnpm redis:up        # development Redis on 127.0.0.1:6379
pnpm redis:test:up   # test Redis on 127.0.0.1:6380, no persistence
```

Then set, in `.env.local`:

```bash
REDIS_ENABLED=true
REDIS_URL=redis://127.0.0.1:6379
```

| Command                | Purpose                                |
| ---------------------- | -------------------------------------- |
| `pnpm redis:up`        | Start the development Redis service.   |
| `pnpm redis:down`      | Stop and remove the Redis services.    |
| `pnpm redis:status`    | Show Redis service status.             |
| `pnpm redis:logs`      | Follow development Redis logs.         |
| `pnpm redis:test:up`   | Start the isolated test Redis service. |
| `pnpm redis:test:down` | Remove the test Redis container.       |
| `pnpm redis:test:logs` | Follow test Redis logs.                |

Both services bind to `127.0.0.1`. A development Redis has no authentication, so
it must not be reachable from the network.

## Enabling Redis in a deployment

Set `REDIS_ENABLED=true` and `REDIS_URL` in the platform's own configuration.

- Use `rediss://` outside a private network. `redis://` sends the password in the
  clear, and the URL _is_ the credential.
- Store `REDIS_URL` in the platform's managed secret store, never in a committed
  file.
- `REDIS_KEY_PREFIX` distinguishes tenants of a shared server. Give each
  deployment its own; the default is `next-fullstack-starter`.
- `REDIS_CONNECT_TIMEOUT_MS` bounds how long a first connection may take.

## Configuration

| Variable                   | Required          | Default                  | Purpose                            |
| -------------------------- | ----------------- | ------------------------ | ---------------------------------- |
| `REDIS_ENABLED`            | No                | `false`                  | Turns Redis on. `true` or `false`. |
| `REDIS_URL`                | Only when enabled | none                     | `redis://` or `rediss://` only.    |
| `REDIS_KEY_PREFIX`         | No                | `next-fullstack-starter` | First segment of every key.        |
| `REDIS_CONNECT_TIMEOUT_MS` | No                | `5000`                   | Bounded, 100–30000.                |
| `REDIS_TEST_RUN_ID`        | No                | generated                | Isolates one test run's keys.      |
| `REDIS_TEST_WORKER_ID`     | No                | runner's worker id       | Isolates one worker of a run.      |

A failure names the scope and the variable and never prints the URL, so a
misconfigured password does not end up in a build log.

## Connection lifecycle

```ts
isRedisEnabled(): boolean;
getRedisClient(): Promise<RedisClientType | null>;
requireRedisClient(): Promise<RedisClientType>;
closeRedisClient(): Promise<void>;
```

- `getRedisClient()` answers `null` when Redis is **disabled**, and only then. An
  enabled Redis that cannot be reached rejects instead: answering `null` there
  would let a caller mistake an outage for a deliberate absence and skip work
  silently.
- `requireRedisClient()` fails when Redis is disabled and when it is unreachable.
- The client is a lazy singleton held on `globalThis`, so a development reload
  reuses the open connection instead of leaking one per reload, and the `error`
  listener is attached once per client rather than once per module evaluation.
- Concurrent first callers share one connection promise, so ten simultaneous uses
  open one socket.
- A failed attempt clears that promise before rejecting. A cached rejection would
  poison every later call for the life of the process, turning one unreachable
  moment into a permanently broken Redis.
- The reconnect policy is bounded — a few short attempts, then failure. An
  unbounded retry loop would hang a request, a test, or a build instead of
  reporting that Redis is unavailable.
- No signal handler is registered. A platform module that installed one would be
  deciding shutdown behaviour for every host that imports it.
  `closeRedisClient()` exists for tests and for an explicit shutdown.

Connection logs carry an event name and, at most, the constructor name of a
failure — never the URL, the host, the username, the password, or the raw error.

## Health contract

```ts
type RedisHealth =
  | { status: "disabled" }
  | { status: "healthy"; latencyMs: number }
  | { status: "unhealthy"; code: "REDIS_UNAVAILABLE" };
```

- `disabled` opens no connection and creates no client, so calling
  `checkRedisHealth()` on the readiness path of a project that does not use Redis
  costs nothing — and a disabled Redis must never make an application look
  unhealthy.
- `healthy` follows a `PING` bounded by the configured timeout.
- `unhealthy` carries a stable code and nothing else. A health result is the most
  likely thing in a system to be rendered on a page or shipped to a dashboard,
  which is exactly where a driver message or a connection string must not reach.

No public health endpoint is added by this change, and no existing route is made
to depend on Redis.

## Key namespaces

Keys are built in one place and never composed at a call site:

```text
<prefix>:<environment>:<namespace>:<segments…>
```

and under test:

```text
<prefix>:test:<run-id>:<worker-id>:<namespace>:<segments…>
```

The closed namespace set is `cache`, `rate-limit`, `lock`, `temporary`, and
`idempotency`. None of those concerns is implemented yet; naming them now is what
stops the first cache key and the first rate-limit key from being invented
independently and colliding.

Rules:

- No raw key string outside `src/platform/redis`.
- A segment carries no separator, no whitespace, and no glob character. The
  separator would let a caller forge a key in another namespace; a glob character
  would make a key impossible to match safely with `SCAN`.
- An empty or malformed segment is refused, and a key needs at least one segment.
- Environments are separated by **prefix**, never by database number. `SELECT` is
  not used: a numbered database is invisible in a key, silently shared by a
  connection, and unavailable in a cluster.
- `KEYS`, `FLUSHDB`, and `FLUSHALL` appear nowhere. `KEYS` blocks the server while
  it walks the whole key space; the two flush commands would erase every other
  tenant of the same server.

## Test isolation

Every test run gets its own key space. `REDIS_TEST_RUN_ID` is used when the runner
supplies one — CI passes the run id and attempt — and one is generated otherwise,
so two runs against the same server cannot see each other's keys even when nobody
remembered to set a variable. Parallel workers of one run are separated further by
worker id.

Cleanup scans that scope and only that scope, with `SCAN` and `UNLINK`. The
delete-by-prefix helper lives in `tests/fixtures/redis.fixture.ts` rather than in
the platform module: production code has no reason to be able to erase a swathe of
keys, and giving it the ability would be giving a future bug the ability.

The suite lives in `tests/redis`, runs under its own `vitest.redis.config.ts`, and
is reachable only through:

```bash
pnpm test:redis:integration
```

It is not a project of `vitest.config.ts`, so `pnpm test`, `pnpm test:unit`,
`pnpm test:coverage`, and `pnpm verify` cannot reach it and cannot require a
server.

## Boundaries

- The `redis` driver may be imported only inside `src/platform/redis`. A dedicated
  ESLint rule and a contract test enforce it; everything else uses
  `@/platform/redis/index.server`, which re-exports the client type so even a type
  import stays inside the boundary.
- The Redis platform must not reach Prisma, a database client, a queue, Better
  Auth, React, translations, an application adapter, routing, a business module,
  or UI code.
- No core module imports Redis, and a contract test asserts that for each of them
  by name.

## Not implemented

Deliberately absent, and to be taken up on their own merits:

- a cache service, and cache invalidation;
- a rate limiter and its storage;
- a distributed lock algorithm;
- an idempotency store behind the Route Handler factory's existing hook;
- session storage and a Better Auth Redis adapter;
- pub/sub and streams;
- Redis Cluster and Sentinel;
- a production health endpoint.

The Route Handler factory already declares typed rate-limit and idempotency hooks.
Wiring them to Redis is a later change; this one only makes a connection
available.

## The queue runs on a different driver

Background jobs also use Redis, and they deliberately do **not** use this
foundation. BullMQ requires `ioredis` and needs a connection configured the way a
consumer needs it — blocking reads, no client-side retry limit, its own key
layout under its own prefix — which is the opposite of what a cache read wants.

So there are two drivers, each confined to one directory: `redis` and `@redis/*`
inside `src/platform/redis`, and `ioredis` and `bullmq` inside
`src/platform/jobs`. Neither may import the other's driver, jobs may not use this
key builder, and the two areas are removable independently in either order. The
`architecture/no-redis-driver-import` rule enforces both halves.

See
[`background-jobs-and-outbox.md`](./background-jobs-and-outbox.md).

## Removing Redis from a generated project

Redis is a leaf. Removing it touches nothing that holds business logic.

1. Delete `src/platform/redis`.
2. Delete `src/platform/cache/redis-cache-aside.server.ts` and its unit test, and
   remove its re-exports from `src/platform/cache/index.server.ts`.
3. Delete the whole of `src/platform/concurrency`. Rate limiting, idempotency,
   and locks are Redis implementations; nothing else depends on them.
4. In `src/platform/cache/cache-invalidation.ts`, drop the `redis` field from
   `CacheInvalidation`; in `cache-invalidation.server.ts`, drop the block that
   runs it.
5. Delete `compose.redis.yaml` and `compose.redis.env.example`.
6. Delete `vitest.redis.config.ts` and `tests/redis`.
7. Delete `tests/fixtures/redis.fixture.ts`,
   `tests/contract/redis-foundation.contract.test.ts`, and the Redis sections of
   `tests/contract/cache-concurrency-controls.contract.test.ts`.
8. Delete `src/config/env/read-redis.ts`, its unit test, and the Redis section of
   `src/config/env/schema.ts`.
9. In `package.json`, remove the `redis` dependency and the `redis:*` and
   `test:redis:integration` scripts.
10. In `.github/workflows/ci.yml`, remove the `redis` service, the
    `REDIS_ENABLED` job variable, and the `Run Redis integration tests` step.
11. In `.env.example` and `src/config/README.md`, remove the Redis variables.
12. In `tools/eslint/architecture-plugin.mjs`, drop the cache-driver entry from
    `no-redis-driver-import` — keep the rule and its queue-driver entry if
    background jobs remain — and remove the `architecture/redis-platform` and
    `architecture/concurrency-platform` blocks from `eslint.config.mjs`.
13. Delete this document and its links from `docs/architecture/README.md`,
    `docs/architecture/module-map.md`, and `src/platform/README.md`.

### What survives

The Next.js side of caching is independent of Redis and stays exactly as it is:

- `cacheComponents` and the `cacheLife` profiles in `next.config.ts`.
- Cache identities, `applyCachePolicy`, `applyCacheTags`, and every cache tag.
- Path and tag invalidation through `runCacheInvalidation`.

`defineRoute` and `defineAction` need no change. They orchestrate a rate-limit
hook, an idempotency lifecycle, and an invalidation plan, and all three are
declarations a definition supplies — a project with no Redis simply supplies
none.

Nothing under `src/platform/auth`, `src/platform/database`,
`src/platform/actions`, `src/platform/http`, `src/platform/proxy`,
`src/platform/observability`, `src/app`, `src/modules`, or `src/ui` needs to
change, because none of them imports Redis. No business code needs to change
except code that explicitly chose a Redis adapter. After the removal,
`pnpm verify` passes unchanged.
