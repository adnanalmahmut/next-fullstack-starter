# Redis

An optional, lazily connected Redis client, a health contract, and a key
discipline. Nothing else in the repository depends on this directory, and
deleting it is the whole of removing Redis from a project.

## Files

| File               | Responsibility                                                  |
| ------------------ | --------------------------------------------------------------- |
| `config.ts`        | Lazy, memoized configuration and the key scope of this process. |
| `client.server.ts` | The lazy singleton client and its connection lifecycle.         |
| `health.server.ts` | The three-state health contract.                                |
| `namespace.ts`     | The closed set of key namespaces.                               |
| `key.ts`           | The only place a key or a `SCAN` pattern is built.              |
| `index.server.ts`  | The controlled server-only entry point.                         |

## Usage

```ts
import {
  buildRedisKey,
  getRedisClient,
  getRedisKeyScope,
  REDIS_NAMESPACE,
} from "@/platform/redis/index.server";

const client = await getRedisClient();

if (client) {
  const key = buildRedisKey(
    getRedisKeyScope(),
    REDIS_NAMESPACE.CACHE,
    "user",
    userId,
  );

  await client.set(key, payload, { expiration: { type: "EX", value: 60 } });
}
```

A caller that cannot proceed without Redis uses `requireRedisClient()` instead
and lets the failure surface.

## Rules

- Redis is optional. `REDIS_ENABLED` defaults to `false`, `REDIS_URL` is required
  only when it is `true`, and there is no default URL and no `localhost`
  fallback in production code.
- Nothing connects at import time. The first call that needs Redis opens the
  socket; a process that never calls one of these functions never connects.
- Every server module is `import "server-only"`.
- The `redis` driver is imported only inside this directory; the client type is
  re-exported from `index.server.ts` so even a type import stays inside the
  boundary. An ESLint rule and a contract test enforce it.
- `getRedisClient()` answers `null` when Redis is disabled and only then. An
  enabled Redis that is unreachable rejects.
- The reconnect policy is bounded, a failed attempt is not cached, and no process
  signal handler is registered.
- A log line carries an event name and, at most, an error's constructor name.
  Never the URL, the host, a credential, or the raw error.
- A health result is a status, a latency, or a stable code. Nothing else.
- Keys are built by `key.ts`. No raw key string, no `SELECT`, no `KEYS`, no
  `FLUSHDB`, and no `FLUSHALL` anywhere.
- This directory implements no cache, rate limiter, lock, or idempotency store.

The architectural policy is documented in
[`docs/architecture/redis-foundation.md`](../../../docs/architecture/redis-foundation.md),
including the removal procedure.
