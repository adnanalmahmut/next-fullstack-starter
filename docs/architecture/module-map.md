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
- [Module Development Guide](../../src/modules/README.md)
- [Repository Rules](../../AGENT_RULES.md)
