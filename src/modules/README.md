# Modules

Business capabilities live here as feature-first, layered modules.

Do not create a module for a framework, database, provider, or other technical
concern. Technical infrastructure belongs in a precisely scoped platform area.

## Structure

A real module may contain:

```text
src/modules/<module>/
├── module.config.ts
├── README.md
├── domain/
├── application/
├── infrastructure/
├── presentation/
├── index.server.ts
└── index.client.ts
```

Create only the layers and files required by the feature.

## Responsibilities

- `domain` owns business concepts and invariants.
- `application` owns use cases, workflows, and ports.
- `infrastructure` implements ports and provider integration.
- `presentation` adapts application behavior to UI and HTTP boundaries.
- `index.server.ts` exposes the controlled server API.
- `index.client.ts` exposes the controlled client-safe API.

## Public boundaries

Cross-module imports must use:

```text
index.server.ts
index.client.ts
```

Do not import another module's internal files.

Server entries and module infrastructure files must import:

```ts
import "server-only";
```

An `index.client.ts` file is a client-safe export boundary. It does not require
the `"use client"` directive unless the file genuinely defines a Next.js client
boundary.

Client-safe exports must not expose:

- Prisma, PostgreSQL drivers, or database clients.
- Redis clients.
- Better Auth server APIs.
- Node.js built-ins.
- Server module entries.
- Infrastructure implementations.
- Private environment variables.

Business module files must consume validated configuration through controlled
entry points or explicit inputs. They must not read `process.env` directly.

## Module configuration

Every real module declares its ownership through `module.config.ts`, including:

- Module name.
- Owned Prisma models.
- Permissions.
- Published integration events.
- Consumed integration events.

## Tests

Place tests according to their purpose:

- Domain and application behavior: unit tests.
- Database and provider adapters: integration tests.
- Stable interfaces and architecture rules: contract tests.
- User journeys: end-to-end tests.

## Before adding a module

Confirm that:

- The capability has real business meaning.
- Ownership is explicit.
- The module does not duplicate an existing capability.
- Shared abstractions are based on repeated real use.
- Public entries expose only intentional APIs.
- No circular dependency is introduced.

Run:

```bash
pnpm architecture:check
pnpm test:contract
pnpm check
```

## Documentation

- [Layer and Module Boundaries](../../docs/architecture/layer-boundaries.md)
- [Module Map](../../docs/architecture/module-map.md)
- [Repository Rules](../../AGENT_RULES.md)
