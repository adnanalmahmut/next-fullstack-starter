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
