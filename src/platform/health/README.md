# Operational Health

Implementation rules for `src/platform/health`. The architectural policy is in
[`docs/architecture/operational-health.md`](../../../docs/architecture/operational-health.md).

## Files

| File                          | Owns                                                                    |
| ----------------------------- | ----------------------------------------------------------------------- |
| `health-code.ts`              | every published machine code, in one closed set                         |
| `health-status.ts`            | the four status vocabularies                                            |
| `dependency-check.ts`         | the check port, the report type, and the timeout bounds                 |
| `health-registry.ts`          | `createHealthRegistry` — an immutable value, not a registry you add to  |
| `run-health-checks.server.ts` | bounded, concurrent orchestration that cannot fail                      |
| `liveness.ts`                 | the constant liveness document                                          |
| `readiness.ts`                | aggregation, the two HTTP statuses, and the fallback document           |
| `health-headers.ts`           | `no-store` and the JSON content type, in one place                      |
| `liveness-response.ts`        | the liveness serializer, split so readiness types stay out of its graph |
| `readiness-response.ts`       | the readiness serializer                                                |
| `health-log-fields.ts`        | the closed log-field allowlist                                          |
| `log-event.ts`                | the two stable event names                                              |
| `health-logger.server.ts`     | the single writer                                                       |
| `liveness.server.ts`          | `createLivenessHandler` — entry point for the liveness route            |
| `web-readiness.server.ts`     | the web composition and the three platform mappings                     |
| `readiness.server.ts`         | `createReadinessHandler` — entry point for the readiness route          |
| `worker-readiness.server.ts`  | `checkWorkerReadiness`, with its checks injected                        |
| `index.server.ts`             | the shared contracts, for a worker process                              |

## Three entry points, split by process

| Entry point           | Imported by             | May reach                                            |
| --------------------- | ----------------------- | ---------------------------------------------------- |
| `index.server.ts`     | `pnpm jobs:health`      | the contracts and the logger                         |
| `liveness.server.ts`  | `GET /api/health/live`  | four constant modules, one serializer, `next/server` |
| `readiness.server.ts` | `GET /api/health/ready` | the above plus database, Redis, storage              |

Importing `@/platform/database` constructs the Prisma client at module
evaluation, so a single shared entry point would make the liveness route build a
connection pool to answer a question that touches nothing — while still
answering `200`, so nothing would reveal it. A dependency-cruiser reachability
rule and a contract test hold each row.

Nothing else in the repository may import a file inside this directory. Every
`*.server.ts` module here begins with `import "server-only";`, so none of them
can be pulled into a browser bundle.

## Rules

- **Own no probe.** Every check comes from the area that owns the client:
  `checkDatabaseHealth` from `@/platform/database`, `checkRedisHealth` from
  `@/platform/redis`, `checkStorageHealth` from `@/platform/storage`, and
  `checkJobsQueueHealth` from `@/platform/jobs` — the last one injected by the
  worker entry point rather than imported here, so background jobs stay
  deletable. No `$queryRaw`, no `.ping()`, and no `HeadBucket` anywhere in this
  directory.
- **Never import** Prisma, `pg`, a Redis driver, BullMQ, the AWS SDK, Better
  Auth, `@/platform/{auth,audit,cache,concurrency,jobs,actions,http,proxy}`,
  `@/worker`, `@/app`, `@/modules`, `@/ui`, `@/i18n`, React, or `next-intl`.
  `@/platform/database` is the one persistence import allowed;
  `next/server` is the one Next.js import, and only for `connection()`.
- **A registry is a value.** No `register()`, no module-level collection, no
  import-time side effect, nothing on `globalThis`. Build one in a composition
  function and hand it to a handler.
- **Every check declares its own failure code and its own timeout**, within
  100–5 000 ms. Never derive a code from a thrown value.
- **Never read a caught value.** Every `catch` here is bare. A driver error
  carries the address it failed to reach.
- **A public document carries a status and a code, and nothing else.** No
  message, no latency, no timestamp, no host, no bucket, no endpoint.
- **`await connection()` before answering**, in the factory rather than in a
  `route.ts`. With Cache Components enabled a `GET` handler that reads no request
  data is prerendered at build time; `export const dynamic` was removed in
  Next.js 16.
- **Log through `logHealthEvent` only**, never `logger` directly and never
  `console`.
- **Cache nothing.** No `"use cache"`, no `@/platform/cache`, no memoized last
  answer.

## Adding a dependency to web readiness

1. Add a `check<Name>Health()` to the area that owns the client, answering its own
   closed status set with its own stable code.
2. Add the code to `HEALTH_CODE`, and a mapping function to
   `web-readiness.server.ts`.
3. Add an entry to `createWebReadinessRegistry` with a bounded timeout and the
   published failure code.
4. Add `<name>Status` to the log-field allowlist if the failing line should carry
   it.

If the dependency is optional, its check must answer `disabled` from
configuration alone — no client, no socket, no name resolution — or it is not
optional.
