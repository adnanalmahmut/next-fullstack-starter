# Authentication

Better Auth 1.6.25 with the Prisma adapter and the Admin plugin.

The architectural policy, session and cookie decisions, migration ownership, and
deferred work are documented in
[`docs/architecture/authentication-foundation.md`](../../../docs/architecture/authentication-foundation.md).

## Files

```text
auth.server.ts             Better Auth server instance (server-only)
auth-client.ts             client-safe Better Auth client
access-control.ts          combined statements and the two least-privilege roles
registration-policy.ts     pure sign-up availability policy
return-to.ts               pure safe-redirect policy
session.server.ts          server-side session reads (server-only)
presentation/login-form.tsx    client boundary for sign-in
presentation/logout-button.tsx client boundary for sign-out
authorization/             capability permissions, actor, policies, audit trail
```

## Authorization

The `authorization` area owns every access decision:

```text
permission-registry.ts            the only place a permission is declared
role.ts                           closed role set and role normalization
actor.ts / actor.server.ts        the normalized server-side actor
capability.ts                     capability evaluation against the declared roles
require-permission.server.ts      requireActor / requirePermission / any / all
policies/                         pure resource-level decisions
admin-endpoints.ts                the allowlist of Better Auth admin endpoints
admin-guard.server.ts             the Better Auth hooks that enforce it
admin-users.service.server.ts     the supported administrative operations
admin-audit.service.server.ts     the bounded audit read
audit/                            the append-only audit trail
identity-read.repository.server.ts bounded read-only identity queries
presentation/                     the administration area UI, copy via props
```

The architectural policy is documented in
[`docs/architecture/authorization-admin-access-control.md`](../../../docs/architecture/authorization-admin-access-control.md).

## Reading a session

```ts
// Server Component
import { getCurrentSession } from "@/platform/auth/session.server";

const session = await getCurrentSession();
```

```ts
// Route Handler or integration test
import { getSessionFromHeaders } from "@/platform/auth/session.server";

const session = await getSessionFromHeaders(await headers());
```

Both reach the database through Better Auth on every call.

## Rules for changes

- This is not an authorization boundary in itself. Every protected page, Route
  Handler, Server Action, and use case must read the session on the server.
- Do not treat `useSession` or any client value as an access decision.
- Do not add a session hint or an optimistic redirect to the proxy.
- Reuse the shared Prisma client. Never construct `PrismaClient` here.
- Read configuration through `serverEnv` and `publicEnv`, never `process.env`.
- Never add a runtime fallback for `BETTER_AUTH_SECRET`.
- Keep the API route a thin `toNextJsHandler` binding.
- Keep sessions database-backed. Do not enable cookie cache, secondary storage,
  or a stateless session format without a documented decision.
- Do not override password hashing.
- Do not widen the Admin plugin: no business resource, no impersonation, and no
  operation outside the four the `authorization` area supports.
- Every access decision goes through `require-permission.server.ts`. Never compare
  a role name; an ESLint rule refuses it.
- Add a permission only in `permission-registry.ts`, and name a role only in
  `role.ts` or `access-control.ts`.
- `role` stays server-owned. It must never be accepted from input.
- Surface only generic localized errors. Never render a provider message and
  never log credentials, cookies, or request bodies for auth endpoints.
- Extend `return-to.ts` by tightening it, never by loosening it.
- `nextCookies()` is only needed if authentication moves to Server Actions. It is
  not used today and would require its own decision and tests.

## Enforcement

- ESLint restricts imports for the auth platform, the client boundary, the
  application routes, and the proxy pipeline.
- `tests/contract/authentication.contract.test.ts` asserts the configuration,
  boundaries, routes, migration, localization, and dependency pins.
- `tests/contract/authorization-admin-access-control.contract.test.ts` asserts the
  registry, the access-control shape, the endpoint allowlist, the audit model and
  migration, and the administration surface.
- `tests/integration/authentication.integration.test.ts` and
  `tests/integration/authorization.integration.test.ts` exercise the real database
  and the real Better Auth instance.
- `tests/e2e/authentication.e2e.spec.ts` and
  `tests/e2e/authorization.e2e.spec.ts` cover both locales end to end.
