# Authentication

Better Auth 1.6.25 with the Prisma adapter and the Admin plugin.

The architectural policy, session and cookie decisions, migration ownership, and
deferred work are documented in
[`docs/architecture/authentication-foundation.md`](../../../docs/architecture/authentication-foundation.md).

## Files

```text
auth.server.ts             Better Auth server instance (server-only)
auth-client.ts             client-safe Better Auth client
access-control.ts          Admin plugin statements and the user/admin roles
registration-policy.ts     pure sign-up availability policy
return-to.ts               pure safe-redirect policy
session.server.ts          server-side session reads (server-only)
presentation/login-form.tsx    client boundary for sign-in
presentation/logout-button.tsx client boundary for sign-out
```

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
- Do not widen the Admin plugin: no business resources, no administrative
  interface, no impersonation, no permission checks in pages.
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
- `tests/integration/authentication.integration.test.ts` exercises the real
  database and the real Better Auth instance.
- `tests/e2e/authentication.e2e.spec.ts` covers both locales end to end.
