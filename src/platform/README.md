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
