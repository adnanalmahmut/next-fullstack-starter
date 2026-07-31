# Database Platform

This directory contains the shared PostgreSQL and Prisma runtime integration.

## Files

### `prisma.ts`

Creates the single Prisma Client instance with `@prisma/adapter-pg`.

The module:

- imports `server-only`;
- reads the validated connection string through `databaseEnv`;
- creates the PostgreSQL driver adapter;
- reuses the client through `globalThis` outside production;
- prevents repeated connection pool creation during Next.js development reloads.

No module, request, job, component, or test may instantiate another Prisma Client.

### `index.server.ts`

Exposes the controlled server-only database entry point.

Import it with:

```ts
import { database } from "@/platform/database/index.server";
```

## Connection Lifecycle

The application singleton remains connected for the lifetime of the server process. Application request handling must not call `$disconnect()` after each request.

Integration tests use the shared database entry point rather than creating another Prisma Client. The database integration suite disconnects the client during suite teardown.

## Generated Client

Prisma Client is generated into:

```text
src/generated/prisma
```

The generated directory is excluded from Git, ESLint, and coverage reporting.

Generate it with:

```bash
pnpm db:generate
```

## Schema and Migrations

Prisma loads the schema directory configured in `prisma.config.ts`:

```text
prisma
```

The main generator and datasource definitions live at:

```text
prisma/schema.prisma
```

Future module-owned schema files can be grouped under:

```text
prisma/schema
```

Migrations live under:

```text
prisma/migrations
```

Apply them with `pnpm db:migrate:deploy`. `prisma db push` and
`prisma migrate reset` are not used, and migrations are reviewed before merge.

Better Auth receives the same shared client through its Prisma adapter and owns
the technical identity models in `prisma/identity.prisma`. Application code must
not query those models directly; see
[`docs/architecture/authentication-foundation.md`](../../../docs/architecture/authentication-foundation.md).

Business models must be added with the business module that owns them rather than as speculative infrastructure.
