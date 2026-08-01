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

### Observability

```text
src/platform/observability/index.server.ts
src/instrumentation.ts
src/proxy.ts
```

Responsibilities:

- Expose the controlled server-only structured logging and request-context API.
- Validate, generate, propagate, and return `x-request-id` values.
- Isolate request context with `AsyncLocalStorage`.
- Emit Pino JSON with stable fields, event names, and redaction.
- Delegate safe Next.js request-error reporting without exposing raw errors.

The proxy integration remains limited to paths covered by its matcher. Future
Action, Route Handler, webhook, cron, and job boundaries must initialize or
propagate their own context. The detailed policy is defined in
[`observability.md`](./observability.md).

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
src/app/api/admin
prisma/authorization.prisma
```

Responsibilities:

- Declare every capability permission once, in the registry.
- Normalize a verified session into the server-side actor.
- Provide the only capability gate application code uses.
- Hold the resource policies for the supported administrative operations.
- Apply the capability, the policies, and the audit record to the Better Auth
  Admin endpoints, including a direct call.
- Own the append-only authorization audit trail and its migration.
- Serve the protected, localized administration area and its API.

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
- [Observability Foundation](./observability.md)
- [Proxy Request Pipeline](./proxy-request-pipeline.md)
- [Authentication Foundation](./authentication-foundation.md)
- [Server Action Factory](./server-action-factory.md)
- [Design System](../design-system/README.md)
- [Module Development Guide](../../src/modules/README.md)
- [Repository Rules](../../AGENT_RULES.md)
