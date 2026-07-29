# Layer and Module Boundaries

This document defines the dependency rules for business modules and the
client/server boundary.

The rules are enforced by ESLint, the local architecture ESLint plugin,
Dependency Cruiser, and contract tests.

## Dependency model

A business module follows this dependency direction:

```text
presentation ────────> application ────────> domain
      │                     │                   │
      │                     └───────────────> shared
      │
      ├──────────────> platform action and HTTP factories
      ├──────────────> i18n
      └──────────────> ui

infrastructure ──────> application ports
       │
       ├─────────────> domain contracts
       ├─────────────> platform infrastructure
       └─────────────> external SDKs
```

Dependencies must point toward business policy, not from business policy toward
frameworks or infrastructure.

## Module structure

A real business module uses this structure:

```text
src/modules/<module>/
├── module.config.ts
├── domain/
├── application/
├── infrastructure/
├── presentation/
├── index.server.ts
├── index.client.ts
└── README.md
```

A module may omit a layer when the feature does not require it. Empty folders
must not be created as placeholders.

## Domain

The domain layer owns business concepts and invariant business rules.

It may import:

- Other files from its own domain layer.
- Stable, framework-independent primitives from `src/shared`.

It must not import:

- Next.js.
- React or React DOM.
- Prisma.
- Database or Redis clients.
- Better Auth.
- Environment configuration.
- Translation APIs.
- Platform services.
- Application, infrastructure, or presentation code.

Business module files must not read `process` or `process.env` directly.
Use validated values from controlled configuration entry points or explicit
dependency injection.

## Application

The application layer coordinates use cases and defines ports required by the
business workflow.

It may import:

- Its own domain.
- Its own application ports and application services.
- Stable primitives from `src/shared`.
- Another module through a controlled public entry point when the workflow
  requires a real cross-module dependency.

It must not import:

- React components.
- Next.js request, response, navigation, cookie, or header APIs.
- Prisma or database clients directly.
- Redis clients directly.
- UI or translation code.
- Infrastructure or presentation implementations.
- Environment configuration directly.

Application code receives dependencies and validated configuration through
explicit inputs or ports.

## Infrastructure

The infrastructure layer implements application ports.

It may import:

- Domain contracts.
- Application ports.
- Prisma and database infrastructure.
- Redis infrastructure.
- External provider SDKs.
- Server-safe platform services.
- Validated server configuration through controlled configuration entries.

It must not:

- Application routing.
- React UI.
- Translation APIs.
- Presentation code.
- Read `process` or `process.env` directly.

Every module infrastructure file must import:

```ts
import "server-only";
```

Infrastructure may implement persistence and provider integration. Business
decisions remain in the domain or application layer.

## Presentation

The presentation layer adapts application behavior to Next.js, React, HTTP, and
localized user interfaces.

It may import:

- Its own application use cases.
- Presenters and presentation-specific DTOs.
- Platform action and HTTP factories.
- Translation APIs.
- Shared UI components.
- Client-safe configuration through `@/config/env/index.client`.
- Controlled public APIs from other modules.

It must not:

- Query Prisma directly.
- Access database or Redis clients.
- Access server environment readers directly.
- Read `process` or `process.env` directly.
- Import infrastructure implementations.
- Own transaction orchestration.
- Implement core business invariants.

## Cross-module access

Code may import another module only through:

```text
src/modules/<module>/index.server.ts
src/modules/<module>/index.client.ts
```

The following imports are forbidden:

```ts
import { repository } from "@/modules/catalog/infrastructure/repository";
import { Product } from "@/modules/catalog/domain/product";
import { createProduct } from "@/modules/catalog/application/create-product";
```

Use a controlled entry point instead:

```ts
import { createProduct } from "@/modules/catalog/index.server";
```

The same rule applies to code outside `src/modules`, including:

- `src/app`
- `src/config`
- `src/i18n`
- `src/platform`
- `src/shared`
- `src/ui`
- Root source files such as `src/proxy.ts`

Circular dependencies are forbidden.

## Server entry points

Every `index.server.ts` or `index.server.tsx` file must import:

```ts
import "server-only";
```

Server entry points expose the smallest server-safe API required by callers.

They must not become broad barrels that expose module internals indiscriminately.

## Client-safe entry points

`index.client.ts` and `index.client.tsx` expose values that are safe to include
in a client dependency graph.

A client entry point:

- Does not require the `"use client"` directive merely because of its name.
- May export serializable DTOs, types, constants, schemas, and client-safe
  presentation code.
- Must not expose Prisma, PostgreSQL drivers, database clients, Redis,
  Better Auth server APIs, Node.js built-ins, server entry points,
  infrastructure implementations, or private environment variables.

The `"use client"` directive is used only when a file defines an actual
Next.js client boundary.

Files with `"use client"` and all `index.client.*` files are checked by the
local ESLint architecture rule.

Only statically named environment variables beginning with `NEXT_PUBLIC_` are
allowed in client-safe code.

## Shared code

`src/shared` contains stable, framework-independent concepts used by at least
two real business modules.

Do not move code into shared preemptively.

Avoid generic folders and names such as:

- `utils`
- `helpers`
- `services`
- `common`

Prefer names that communicate a precise responsibility.

## Platform code

`src/platform` contains reusable technical infrastructure that is not owned by
one business capability.

Examples include:

- Database lifecycle.
- Authentication infrastructure.
- Cache clients.
- HTTP factories.
- Jobs.
- Observability.
- Rate limiting.
- Storage.

Platform code must not become a location for business rules.

## Automated enforcement

### ESLint

ESLint enforces:

- Layer-specific import restrictions.
- Direct `process` access restrictions in every business module layer.
- Server-only dependency restrictions for client modules.
- Private environment restrictions for client modules.
- Required `server-only` imports in server entries and module infrastructure.
- Zero accepted warnings through `--max-warnings=0`.

### Dependency Cruiser

Dependency Cruiser enforces:

- No circular dependencies.
- No cross-module internal imports.
- No module-internal imports from outside `src/modules`.
- No unresolved source dependencies.
- Exclusion of generated Prisma source from architecture analysis.

### Contract tests

Contract tests verify both allowed and forbidden examples for:

- Layer dependencies.
- Relative-import escape paths.
- Client and server boundaries.
- Controlled module entry points.
- Circular dependencies.
- Unresolved dependencies.
- Generated source exclusion.

## Manual review requirements

Static analysis cannot determine every architectural violation.

Code review must still verify:

- Business decisions remain in domain or application.
- Presentation does not orchestrate database transactions.
- Infrastructure does not decide business policy.
- A module does not update another module's owned models directly.
- Shared abstractions are based on repeated real requirements.
- Public entry points expose only intentional APIs.
- New dependencies do not introduce hidden coupling.

## Commands

Run the architecture check directly:

```bash
pnpm architecture:check
```

Run all static project checks:

```bash
pnpm check
```

Run architecture contract tests:

```bash
pnpm test:contract
```

Run the complete repository verification pipeline:

```bash
pnpm verify
```
