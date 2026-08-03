# Module Map

This document records the source-code areas, current module inventory, and the
required structure for future business modules.

## Source areas

| Path            | Responsibility                                                 |
| --------------- | -------------------------------------------------------------- |
| `src/app`       | Next.js routes, layouts, Route Handlers, and composition roots |
| `src/modules`   | Business capabilities organized as layered modules             |
| `src/platform`  | Shared technical infrastructure and framework integration      |
| `src/shared`    | Stable framework-independent primitives shared by real modules |
| `src/ui`        | Reusable presentation components                               |
| `src/config`    | Validated application configuration                            |
| `src/i18n`      | Locale routing, translation configuration, and navigation      |
| `src/generated` | Generated source that must not be edited manually              |

## Current business module inventory

The starter does not currently contain a business module.

```text
src/modules/
└── README.md
```

Business modules are introduced only when a real feature requires ownership of
business rules, use cases, permissions, persistence, or public module APIs.

Technical concerns must remain in `src/platform`, `src/config`, `src/i18n`, or
another precisely scoped technical area.

## Current controlled technical entries

### Server environment

```text
src/config/env/index.server.ts
```

Responsibilities:

- Marks the entry as server-only.
- Reads validated database configuration.
- Reads validated server configuration.
- Exposes server-safe environment values.

### Client-safe environment

```text
src/config/env/index.client.ts
```

Responsibilities:

- Exposes only validated `NEXT_PUBLIC_*` values.
- Acts as a client-safe entry point.
- Does not create a Next.js client boundary by itself.

### Database

```text
src/platform/database/index.server.ts
```

Responsibilities:

- Marks the entry as server-only.
- Exposes the shared Prisma database instance.
- Prevents callers from depending on the internal client implementation.

### Error primitives and transport contracts

```text
src/shared/errors
src/platform/errors
src/platform/actions
src/platform/http
```

Responsibilities:

- Keep application error identity and stable error codes framework-independent.
- Normalize unknown failures into a minimal public error.
- Define client-safe Action result and HTTP response shapes.
- Map every public error code to an HTTP status exhaustively.

The detailed contracts and dependency direction are defined in
[`error-handling.md`](./error-handling.md).

### Server Action factory

```text
src/platform/actions/index.server.ts
```

Responsibilities:

- Create every Server Action through one adapter, in a fixed order: validate,
  resolve the actor, authorize, run `beforeExecute`, run the use case, run
  `afterSuccess`, invalidate the declared cache entries.
- Declare the closed set of authorization modes and derive the actor type from the
  declared mode.
- Infer the input type from the Zod schema and the output type from the use case.
- Normalize every failure into an `ActionResult` through the shared public error
  mapping.
- Emit `server_action.*` events carrying only allowlisted fields.

The adapter holds no business logic and reaches no database, repository, business
module, or transport. Post-success audit and cache invalidation are not
transactional with the use case. The detailed policy is defined in
[`server-action-factory.md`](./server-action-factory.md).

### Observability and production telemetry

```text
src/platform/observability/index.server.ts
src/platform/observability/telemetry
src/platform/observability/error-monitoring
src/instrumentation.ts
src/proxy.ts
```

Responsibilities:

- Expose the controlled server-only structured logging and request-context API.
- Validate, generate, propagate, and return `x-request-id` values.
- Isolate request context with `AsyncLocalStorage`.
- Emit Pino JSON with stable fields, event names, and redaction.
- Delegate safe Next.js request-error reporting without exposing raw errors.
- Own the four independent contracts: logging, tracing, metrics, and server-side
  error monitoring. The last three are optional and off by default.
- Own the OpenTelemetry SDK lifecycle for the `web` and `worker` process types,
  and be the only area that imports an SDK or a vendor client.
- Own the closed span, metric, and attribute vocabularies, so no call site can
  invent a name or a dimension.
- Carry the W3C trace-context contract that the outbox and the queue envelope
  store, and restore a remote parent across the process boundary.

With `TELEMETRY_ENABLED=false` and `ERROR_MONITORING_ENABLED=false` — the defaults
— no SDK module is evaluated, no provider is registered, no exporter exists, and no
socket is opened. Every span and every metric is a no-op through
`@opentelemetry/api`, so a call site never branches on whether telemetry is on.

The proxy integration remains limited to paths covered by its matcher. The detailed
policy, the span and metric catalogs, the attribute allowlists, and the removal
procedure are defined in [`observability.md`](./observability.md); the
error-monitoring decision is recorded in
[ADR 2](../adr/0002-server-error-monitoring.md).

### Proxy request pipeline

```text
src/proxy.ts
src/platform/proxy
```

Responsibilities:

- Keep the composition root a matcher declaration and a single pipeline call.
- Negotiate the locale through `next-intl` and synchronize the `APP_LOCALE`
  cookie.
- Forward the `x-request-id` correlation value upstream and return it downstream.
- Apply a minimal baseline of response security headers.
- Classify a pathname into a route area with pure, data-driven rules.

The pipeline makes no authorization decision and reads no session. Protected
pages, Route Handlers, Server Actions, and use cases must authenticate and
authorize independently. The detailed policy is defined in
[`proxy-request-pipeline.md`](./proxy-request-pipeline.md).

### Redis

```text
src/platform/redis
compose.redis.yaml
```

Responsibilities:

- Provide an optional, lazily connected Redis client.
- Own the health contract and the key namespace discipline.
- Stay removable: no other area imports it, and no core module depends on it.

Redis is disabled by default and is not part of startup configuration. Only the
cache and concurrency areas below build on it. The detailed policy is defined in
[`redis-foundation.md`](./redis-foundation.md).

### Cache

```text
src/platform/cache
```

Responsibilities:

- Own the cache identity contract and the closed set of cache-life profiles.
- Declare a lifetime and tags inside a `"use cache"` scope.
- Read through Redis and fall back to the source of truth.
- Be the only place the Next.js invalidation APIs are called.

PostgreSQL remains the source of truth, and business key factories belong to the
module that owns the data.

### Concurrency

```text
src/platform/concurrency
```

Responsibilities:

- Count requests in a fixed window, atomically.
- Claim, complete, and abort an idempotent attempt.
- Coordinate work with a lease lock.
- Adapt all three to the Route Handler factory.

None of them is a correctness mechanism, and every use declares what happens when
Redis is not there. The detailed policy for both areas is defined in
[`cache-and-concurrency-controls.md`](./cache-and-concurrency-controls.md).

### Background jobs

```text
src/platform/jobs
src/worker
prisma/jobs.prisma
vitest.jobs.config.ts
```

Responsibilities:

- Record work in a transactional outbox, inside the caller's own transaction.
- Claim and publish those rows from a separate worker process.
- Run a job with a bounded retry budget, a bounded backoff, and an abort-based
  timeout.
- Make a database effect happen once under at-least-once delivery.
- Stay removable: no route, Server Action, or use case imports it.

Jobs are disabled by default. Writing an outbox row needs `JOBS_ENABLED` and no
Redis at all; only the queue, the worker, and the dispatcher need
`JOBS_REDIS_URL`. BullMQ runs on `ioredis` inside this area alone and manages its
own key namespace, so it shares no driver and no key space with the Redis
foundation above. The detailed policy is defined in
[`background-jobs-and-outbox.md`](./background-jobs-and-outbox.md).

### Application audit

```text
src/platform/audit
src/app/_composition/audit-catalog.ts
prisma/audit.prisma
```

Responsibilities:

- Own the generic audit contracts: the action definition, the actor, the result,
  the metadata policy, the cursor, and the reader DTO.
- Append a record inside the caller's transaction, or after a change some other
  system already committed.
- Store the trail append-only, with no foreign key to anything it refers to.
- Read it back, newest first, bounded and paged by cursor.
- Render it, knowing no vocabulary of its own.

The direction is the point: authentication depends on the audit platform, and
the audit platform depends on nothing above it. An action belongs to whoever
performs it, so `platform/audit` holds none. The detailed policy is defined in
[`application-audit-platform.md`](./application-audit-platform.md).

### Object storage

```text
src/platform/storage
prisma/storage.prisma
compose.storage.yaml
```

Responsibilities:

- Own the S3-compatible provider port and its one adapter, so the SDK and the
  provider are both replaceable without touching the upload lifecycle.
- Own upload policies, the file declaration contract, and the key layout.
- Authorize one direct upload at a time with a presigned POST that pins the key,
  the media type, and the exact size.
- Verify what actually arrived, promote it to an immutable final key, and hand
  out short-lived private downloads.
- Offer an inspection extension point, a bounded cleanup contract, and a health
  contract.

The direction is the point: a future module depends on the storage platform, and
the storage platform depends on no module and on no other platform area. It
never receives an actor — who may upload and who may download are decisions the
calling module makes — and bytes never pass through Next.js. The detailed policy
is defined in
[`object-storage-and-uploads.md`](./object-storage-and-uploads.md).

### Operational health

```text
src/platform/health
src/app/api/health/live
src/app/api/health/ready
src/worker/jobs.health.ts
```

Responsibilities:

- Own the closed set of machine codes, the status vocabularies, the dependency
  port, the immutable registry, and the bounded orchestration around it.
- Answer liveness from a constant, reaching no dependency at all.
- Answer web readiness from PostgreSQL plus whichever optional dependencies are
  enabled, mapping a disabled one to `disabled` rather than to a fault.
- Answer worker readiness as an exit code, distinguishing "something is down"
  from "this will never start".
- Contain every failure, bound every check independently, and keep every address,
  bucket, credential, and exception out of both the document and the log line.

It owns no probe of its own: each check belongs to the area that owns the client,
and the worker's queue check is injected by the worker entry point so this area
never imports `@/platform/jobs`. The two routes are the only exception to
`defineRoute` in the repository, and the exception is exactly two files wide. The
detailed policy is defined in
[`operational-health.md`](./operational-health.md).

### Authentication

```text
src/platform/auth
src/app/api/auth/[...all]
prisma/identity.prisma
```

Responsibilities:

- Configure the Better Auth server instance on the shared Prisma client.
- Apply the environment-derived registration policy.
- Provide server-side session reads for Server Components and Route Handlers.
- Own the technical identity models and their migration.
- Configure the Admin plugin as the single source of roles and permissions.

Authentication is not delegated to the proxy or to client state. The detailed
policy is defined in
[`authentication-foundation.md`](./authentication-foundation.md).

### Authorization

```text
src/platform/auth/authorization
src/app/[locale]/(admin)/admin
src/app/api/v1/admin
prisma/authorization.prisma
```

Responsibilities:

- Declare every capability permission once, in the registry.
- Normalize a verified session into the server-side actor.
- Provide the only capability gate application code uses.
- Hold the resource policies for the supported administrative operations.
- Apply the capability, the policies, and the audit record to the Better Auth
  Admin endpoints, including a direct call.
- Declare the identity audit actions, and record them through the audit
  platform. The trail itself is owned by `src/platform/audit`;
  `prisma/authorization.prisma` is frozen legacy storage.
- Serve the protected, localized administration area and its versioned API.

No access decision is made by comparing a role name, and the proxy plays no part
in it. The detailed policy is defined in
[`authorization-admin-access-control.md`](./authorization-admin-access-control.md).

### Design system

```text
src/ui/primitives
src/ui/patterns
src/ui/layout
```

Responsibilities:

- Keep reviewed shadcn/ui source client-safe and presentation-only.
- Expose semantic, direction-aware primitives through direct imports.
- Compose generic loading, empty, status, and destructive-confirmation states.
- Provide the route-neutral `PageContainer` layout primitive.

Visual tokens live in `src/app/globals.css`; localized copy remains at
presentation boundaries. The detailed policies are defined in the
[design-system documentation](../design-system/README.md).

## Required module template

A new module starts with the minimum structure required by its feature:

```text
src/modules/catalog/
├── module.config.ts
├── README.md
├── domain/
│   ├── product.ts
│   └── product-repository.ts
├── application/
│   └── create-product.ts
├── infrastructure/
│   └── prisma-product-repository.ts
├── presentation/
│   └── product-presenter.ts
├── index.server.ts
└── index.client.ts
```

This is an illustrative structure. Do not create files or layers that the
feature does not need.

## Layer responsibilities

| Layer             | Owns                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `domain`          | Entities, value objects, invariants, domain services, domain contracts |
| `application`     | Use cases, commands, queries, ports, workflow coordination             |
| `infrastructure`  | Prisma repositories, cache adapters, provider adapters                 |
| `presentation`    | Presenters, UI adapters, HTTP adapters, localized output               |
| `index.server.ts` | Intentional server-safe public API                                     |
| `index.client.ts` | Intentional client-safe public API                                     |

Detailed dependency rules are defined in
[`layer-boundaries.md`](./layer-boundaries.md).

## Module configuration

Every real module declares ownership in `module.config.ts`.

Example:

```ts
export const moduleConfig = {
  name: "catalog",
  ownsModels: ["Product", "Category"],
  permissions: [
    "catalog.product.read",
    "catalog.product.create",
    "catalog.product.update",
    "catalog.product.delete",
  ],
  publishesEvents: ["catalog.product-created"],
  consumesEvents: [],
} as const;
```

The configuration records architecture ownership. It must not be used as a
replacement for authorization checks or runtime validation.

## Ownership map

The ownership table is intentionally empty until the first business module is
introduced.

| Module | Models | Public server API | Client-safe API | Published events |
| ------ | ------ | ----------------- | --------------- | ---------------- |
| None   | None   | None              | None            | None             |

Update this table in the same pull request that creates, removes, or changes a
business module's ownership.

## Cross-module communication

Preferred mechanisms:

- A synchronous call through another module's `index.server.ts`.
- A client-safe import through another module's `index.client.ts`.
- An integration event when synchronous coupling is not required.

Forbidden mechanisms:

- Importing another module's repository.
- Importing another module's Prisma adapter.
- Importing another module's internal domain or application file.
- Updating another module's owned database models directly.
- Creating circular module dependencies.

## Adding a module

Before creating a module:

1. Confirm that it represents a real business capability.
2. Define its owned models and permissions.
3. Identify its domain rules and use cases.
4. Define required application ports.
5. Add only the infrastructure needed by those ports.
6. Expose the smallest intentional server and client-safe APIs.
7. Add unit, integration, and contract tests as applicable.
8. Add a module README.
9. Update the ownership map in this document.
10. Run:

```bash
pnpm verify
```

## Related documentation

- [Layer and Module Boundaries](./layer-boundaries.md)
- [Error Handling Contracts](./error-handling.md)
- [Observability and Production Telemetry](./observability.md)
- [Server-side error monitoring (ADR 2)](../adr/0002-server-error-monitoring.md)
- [Proxy Request Pipeline](./proxy-request-pipeline.md)
- [Authentication Foundation](./authentication-foundation.md)
- [Server Action Factory](./server-action-factory.md)
- [Route Handler Factory](./route-handler-factory.md)
- [Redis Foundation](./redis-foundation.md)
- [Cache and Concurrency Controls](./cache-and-concurrency-controls.md)
- [Background Jobs and Transactional Outbox](./background-jobs-and-outbox.md)
- [Design System](../design-system/README.md)
- [Module Development Guide](../../src/modules/README.md)
- [Repository Rules](../../AGENT_RULES.md)
