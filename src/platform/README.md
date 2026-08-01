# Platform

Shared technical infrastructure and framework adapters live here.

Examples include authentication, database access, caching, observability, HTTP adapters, jobs, rate limiting, and storage.

Platform code must not contain business rules. Add scoped platform areas only when the corresponding integration is implemented.

## Database

PostgreSQL access is implemented under `src/platform/database`.

- `prisma.ts` creates and caches the single Prisma Client instance.
- `index.server.ts` exposes the controlled server-only database entry point.
- Generated Prisma Client files live under `src/generated/prisma` and are not committed.
- Prisma schema and migrations live under `prisma`.
- Integration tests create and disconnect their own database client.
- Application request handling must not disconnect the shared client after each request.

Application server code imports the database through:

```ts
import { database } from "@/platform/database/index.server";
```

Business rules must not be implemented in the platform database layer. Business modules should place their database repositories and persistence mappings inside their own infrastructure layer.

## Server Actions

The single Server Action adapter is implemented under `src/platform/actions`.

- `action-result.ts` is the client-safe result contract, imported directly by
  presentation code.
- `define-action.server.ts` owns the fixed order: validate, resolve the actor,
  authorize, run `beforeExecute`, run the use case, run `afterSuccess`, invalidate.
- `action-definition.ts` declares the closed set of authorization modes and
  derives the actor type from the declared mode.
- `cache-invalidation.server.ts` applies statically declared paths and tags after
  a success.
- `log-event.ts` closes the log-field allowlist over the payload type.
- `index.server.ts` exposes the controlled server-only entry point.

The adapter holds no business logic and reaches no database, repository, business
module, or transport; an ESLint boundary enforces that. Post-success audit and
cache invalidation are not transactional with the use case.

Implementation rules are documented in [`actions/README.md`](./actions/README.md)
and the architectural policy in
[`docs/architecture/server-action-factory.md`](../../docs/architecture/server-action-factory.md).

## HTTP

The single Route Handler adapter is implemented under `src/platform/http`.

- `http-response.ts` is the response contract: the envelope types, the
  error-code to status map, and the closed set of success statuses.
- `json-response.ts` is the only place a value becomes a response body.
- `request-input.ts` is the only place a query is collected and a body is read.
- `define-route.server.ts` owns the fixed order: request context, rate limit,
  validation, actor, authorization, idempotency, `beforeExecute`, the use case,
  `afterSuccess`, `audit`, serialization, logging.
- `route-definition.ts` declares the definition shape and infers each input type
  from its own schema.
- `log-event.ts` closes the log-field allowlist over the payload type.
- `index.server.ts` exposes the controlled server-only entry point.

Application endpoints live under `/api/v1` and are thin adapters; the Better Auth
catch-all at `/api/auth/[...all]` is provider owned and is never wrapped. The
adapter holds no business logic and reaches no database, repository, business
module, or rendering API; an ESLint boundary enforces that.

Implementation rules are documented in [`http/README.md`](./http/README.md), the
architectural policy in
[`docs/architecture/route-handler-factory.md`](../../docs/architecture/route-handler-factory.md),
and the versioning decision in
[`docs/adr/0001-versioned-api-and-openapi-strategy.md`](../../docs/adr/0001-versioned-api-and-openapi-strategy.md).

## Redis

An optional Redis foundation is implemented under `src/platform/redis`.

- `config.ts` reads the configuration lazily; nothing is validated at startup.
- `client.server.ts` is a lazy singleton with a bounded reconnect policy, a
  shared connection promise, and no cached rejection.
- `health.server.ts` answers `disabled`, `healthy`, or `unhealthy` with a stable
  code and no provider detail.
- `namespace.ts` and `key.ts` own the closed namespace set and the only key and
  `SCAN` pattern builder.
- `index.server.ts` exposes the controlled server-only entry point.

Redis is disabled by default and required by nothing: the application builds,
runs, and passes `pnpm verify` with no Redis variable set. The driver may be
imported only inside this directory, enforced by an ESLint rule and a contract
test, so removing Redis is a matter of deleting the directory.

Implementation rules are documented in [`redis/README.md`](./redis/README.md) and
the architectural policy, including the removal procedure, in
[`docs/architecture/redis-foundation.md`](../../docs/architecture/redis-foundation.md).

## Cache

Two caches with one identity are implemented under `src/platform/cache`.

- `cache-identity.ts` and `cache-policy.ts` own the validated identity contract
  and the closed set of cache-life profiles.
- `next-cache.server.ts` declares a lifetime and tags inside a `"use cache"`
  scope; the directive itself is never wrapped.
- `redis-cache-aside.server.ts` reads through Redis and falls back to the source
  of truth whenever Redis cannot answer.
- `cache-invalidation.server.ts` is the only place the Next.js invalidation APIs
  are called, and it is shared by `defineAction` and `defineRoute`.

PostgreSQL remains the source of truth. Business key factories belong to the
module that owns the data, never to this directory.

Implementation rules are documented in [`cache/README.md`](./cache/README.md).

## Concurrency

A rate limiter, an idempotency lifecycle, and a lease lock are implemented under
`src/platform/concurrency`.

- `rate-limit.server.ts` is a fixed-window limiter whose increment and expiry are
  one atomic script.
- `idempotency.server.ts` is a `begin` / `complete` / `abort` lifecycle guarded
  by an owner token, not a lookup separate from its completion.
- `lock.server.ts` is a single-Redis lease lock with a compare-and-delete
  release. It is not Redlock and it does not protect an invariant on its own.
- `route-adapters.server.ts` is the only bridge to `defineRoute`.

Every use names its own fallback for a disabled or unreachable Redis; there is no
implicit default. No existing endpoint is wired to any of these.

Implementation rules are documented in
[`concurrency/README.md`](./concurrency/README.md), and the architectural policy
for both areas in
[`docs/architecture/cache-and-concurrency-controls.md`](../../docs/architecture/cache-and-concurrency-controls.md).

## Background jobs

An optional transactional outbox and BullMQ worker are implemented under
`src/platform/jobs`, with the process entry points under `src/worker`.

- `config/jobs-config.ts` reads the configuration lazily and keeps two levels
  apart: `JOBS_ENABLED` turns the outbox on, `JOBS_REDIS_URL` is required only
  where a queue, a worker, or the dispatcher is built.
- `definitions/` own `defineJob`, the validated envelope, and the closed registry
  keyed by `name.v<version>`.
- `outbox/write-outbox-message.server.ts` takes a `Prisma.TransactionClient` and
  refuses the singleton, so the row and the business change share a commit.
- `outbox/outbox-dispatcher.server.ts` claims with `FOR UPDATE SKIP LOCKED` in a
  short transaction and publishes only after it commits.
- `execution/` own the abort-based timeout, the failure taxonomy, the opaque
  execution key, and `runDatabaseJobOnce`.
- `runtime/worker-runtime.server.ts` starts and stops the consumer and the
  dispatcher together, and registers no signal handler.
- `index.server.ts` exposes the controlled server-only entry point, and
  deliberately does not export the queue.

Jobs are disabled by default and required by nothing: the application builds,
runs, and passes `pnpm verify` with no jobs variable set and no worker running.
`bullmq` and `ioredis` may be imported only inside this directory — the Redis
foundation runs on a different driver — so removing background jobs is a matter
of deleting two directories.

Implementation rules are documented in [`jobs/README.md`](./jobs/README.md) and
the architectural policy, including the removal procedure, in
[`docs/architecture/background-jobs-and-outbox.md`](../../docs/architecture/background-jobs-and-outbox.md).

## Observability

Structured logging and request correlation are implemented under
`src/platform/observability`.

- `index.server.ts` exposes the controlled server-only API.
- Pino emits structured JSON with stable base fields and central redaction.
- `AsyncLocalStorage` scopes typed request context without mutable global
  request bindings.
- Request IDs use the `x-request-id` UUID v4 contract.
- Error logging preserves safe application error codes and excludes raw error
  details.

Architecture and usage rules are documented in
[`docs/architecture/observability.md`](../../docs/architecture/observability.md).

## Proxy

The request pipeline composed by `src/proxy.ts` is implemented under
`src/platform/proxy`.

- `compose.ts` runs the steps in a fixed order.
- `context.ts` carries only the request, pathname, route area, and request ID.
- `route-classifier.ts` and `route-rules.ts` classify a pathname without reading
  a session or producing a response.
- `steps` implement request-ID forwarding, locale negotiation, and baseline
  security headers.

The pipeline is not an authorization boundary and must not access a database, a
cache, a queue, or a business module.

Implementation rules are documented in
[`proxy/README.md`](./proxy/README.md) and the architectural policy in
[`docs/architecture/proxy-request-pipeline.md`](../../docs/architecture/proxy-request-pipeline.md).

## Authentication

Better Auth is configured under `src/platform/auth`.

- `auth.server.ts` builds the server instance on the shared Prisma client.
- `session.server.ts` exposes the server-side session reads.
- `auth-client.ts` is the client-safe entry used only for sign-in and sign-out.
- `access-control.ts` holds the combined statements and the two least-privilege
  roles.
- `registration-policy.ts` and `return-to.ts` are pure, testable policies.

Sessions are database-backed and validated on the server for every read. The
platform is not an authorization boundary by itself.

Implementation rules are documented in [`auth/README.md`](./auth/README.md) and
the architectural policy in
[`docs/architecture/authentication-foundation.md`](../../docs/architecture/authentication-foundation.md).

## Authorization

Capability-based authorization is implemented under
`src/platform/auth/authorization`.

- `permission-registry.ts` declares every permission exactly once.
- `role.ts` owns the closed role set and normalizes a stored role column.
- `actor.ts` and `actor.server.ts` build the normalized server-side actor.
- `require-permission.server.ts` is the only capability gate application code uses.
- `policies/` hold the pure resource-level decisions.
- `admin-guard.server.ts` applies the capability, the policies, and the audit
  record to the Better Auth Admin endpoints, including a direct call.
- `audit/` owns the append-only authorization audit trail.

An authorization decision is never made by comparing a role name; an ESLint rule
refuses that. The proxy plays no part in the decision.

Implementation rules are documented in [`auth/README.md`](./auth/README.md) and
the architectural policy in
[`docs/architecture/authorization-admin-access-control.md`](../../docs/architecture/authorization-admin-access-control.md).
