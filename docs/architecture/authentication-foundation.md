# Authentication Foundation

This document defines the implemented authentication and session foundation. Its
goals are a working email and password sign-in, database-backed sessions that can
be revoked immediately, server-side protection that does not depend on client
state, and a reviewed Prisma migration.

It is a foundation, not a complete identity product. Permission modelling, user
management, and account recovery are deferred.

## Versions and adapter

```text
better-auth                  1.6.25 (exact)
@better-auth/prisma-adapter  1.6.25 (exact)
Prisma provider              postgresql
```

Both packages are pinned to the same exact version. The Better Auth CLI is not a
project dependency; it is invoked through `pnpm dlx auth@1.6.25` only to generate
the schema reference.

The adapter receives the application's existing Prisma client from
`src/platform/database/prisma.ts`. No second client, pool, or PostgreSQL adapter
is created for authentication.

## File structure

```text
src/platform/auth/
├── README.md
├── auth.server.ts                  Better Auth server instance (server-only)
├── auth-client.ts                  client-safe Better Auth client
├── access-control.ts               combined statements and the two roles
├── registration-policy.ts          pure sign-up availability policy
├── return-to.ts                    pure safe-redirect policy
├── session.server.ts               server-side session reads (server-only)
├── authorization/                  capability permissions, actor, policies, audit
└── presentation/
    ├── login-form.tsx              client boundary for sign-in
    └── logout-button.tsx           client boundary for sign-out
```

## API route

```text
src/app/api/auth/[...all]/route.ts
```

It exports `GET` and `POST` from `toNextJsHandler(auth.handler)` and nothing
else: no body parsing, no logging, no response rewriting, and no business logic.
Proxy defaults to the Node.js runtime in Next.js 16, which is what Prisma and
Better Auth need.

## Email and password configuration

```text
emailAndPassword.enabled                  true
emailAndPassword.disableSignUp            derived from the registration policy
emailAndPassword.requireEmailVerification false
password hashing                          Better Auth default (scrypt)
social providers                          none
experimental options                      none
```

Password hashing is not overridden. Hashes are stored on `Account` for the
`credential` provider, never on `User`, and never in plain text.

## Registration policy

```text
development  sign-up API enabled
test         sign-up API enabled
staging      sign-up API disabled
production   sign-up API disabled
```

`isEmailRegistrationEnabled` is a pure function of the validated `APP_ENV`, and
`disableSignUp` is derived from it. Enforcement is server-side at the endpoint:
in staging and production a direct request to `/api/auth/sign-up/email` is
rejected by Better Auth, not merely hidden in the interface.

There is no `/register` route and no registration link. Sign-up exists so
development and automated tests can provision accounts through Better Auth
itself instead of writing password hashes by hand.

The `role` field cannot be supplied through sign-up input. The Admin plugin
declares it with `input: false`, so Better Auth answers `400 FIELD_NOT_ALLOWED`;
the default role is assigned on the server.

## Email verification

No email provider exists in this foundation, so verification cannot be required
and is disabled. Verification email delivery, password reset, and account
recovery are deferred to their own change.

## Session policy

```text
storage      PostgreSQL through the Prisma adapter
expiresIn    7 days   (60 * 60 * 24 * 7)
updateAge    1 day    (60 * 60 * 24)
cookieCache  disabled
```

Sessions are database-backed with no cookie cache, no secondary storage, and no
stateless or JWT session format. Three properties follow from that:

1. every server read consults the database through `auth.api.getSession`;
2. deleting or expiring a session row invalidates it immediately;
3. a cookie captured before sign-out cannot resurrect a session.

## Cookie policy

Better Auth owns the session cookie. `advanced.useSecureCookies` follows
`NODE_ENV === "production"`, which is what produces the `__Secure-` cookie name
prefix in production builds. Observed attributes are `HttpOnly`, `SameSite=Lax`,
`Path=/`, and a `Max-Age` matching `expiresIn`.

Nothing is stored in `localStorage` or `sessionStorage`, and no token is written
by application code.

## Base URL and trusted origins

`baseURL` and `trustedOrigins` are both set explicitly from
`NEXT_PUBLIC_APP_URL`. Better Auth then rejects a state-changing request that
carries a foreign `Origin` with `403 INVALID_ORIGIN`, which is its own CSRF
protection; no custom CSRF mechanism is layered on top and no permissive CORS
policy is added.

`NEXT_PUBLIC_APP_URL` is inlined at build time, so the value used to build the
application must match the origin it is served from. `BETTER_AUTH_URL` is not
introduced, because the explicit `baseURL` already removes the need for
environment inference.

## Rate limiting

Better Auth enables its own rate limiting in production and applies a stricter
default rule to `/sign-in*` and `/sign-up*` (three requests per ten seconds per
address). That default is kept for every real environment.

It is disabled only when `APP_ENV === "test"`, because the automated suite
exercises many such requests from one address within seconds. Designing an
application rate-limit policy, including shared storage, is deferred.

## Login flow

1. `src/app/[locale]/(auth)/login/page.tsx` is a Server Component.
2. It validates the locale, resolves a safe `returnTo`, and reads the session on
   the server. An already-authenticated visitor is redirected away.
3. Localized copy and the resolved `returnTo` are passed to `LoginForm`.
4. `LoginForm` calls `signIn.email` through the Better Auth client, so the server
   sets the session cookie.
5. On success it navigates to `returnTo` and calls `router.refresh()`.
6. On failure it renders one generic localized message. The provider message is
   never surfaced, so a response cannot be used to learn whether an address
   exists.

The form disables submission while a request is pending, marks both inputs with
`autocomplete` hints, and keeps the email and password fields `dir="ltr"` inside a
right-to-left page.

## Logout flow

`LogoutButton` calls `signOut` through the Better Auth client. The server
revokes the session row and clears the cookie; only then does the button navigate
to the localized login path and call `router.refresh()`. Clearing client state is
never treated as a sign-out, and other sessions belonging to the same user are
left usable.

## Server Component protection

`src/app/[locale]/(front-office)/account/page.tsx` reads the session with
`getCurrentSession()` and redirects to the localized login page with a safe
`returnTo` when there is none. It renders only the display name and the email
address, and never the session token, IP address, user agent, or ban metadata.

It does not query Prisma, does not use `useSession`, and does not treat the
presence of a cookie as a session.

## Route Handler session reads

`getSessionFromHeaders(headers)` takes an explicit header set so Route Handlers
and integration tests can use the same code path as Server Components. Neither
helper parses a cookie by hand, queries Prisma directly, or caches a session:
`unstable_cache` and React `cache()` are deliberately not used for a security
decision that must stay per-request.

`/api/diagnostics/auth-session` proves the helper works inside a Route Handler.
It reports only `authenticated` and, when authenticated, the user id and email.
It returns `404` outside development and test, enforced inside the handler rather
than by hiding a link.

## Admin plugin foundation

The Admin plugin is the single source of roles and permissions:

```text
statements    the plugin's own user and session capabilities, plus the
              application capability statements declared in the permission registry
roles         user (nothing granted), admin (least privilege)
defaultRole   user
adminRoles    ["admin"]
```

No business resource is invented, no impersonation interface exists, and no
permission check is spread into application pages. The administrative fields
(`role`, `banned`, `banReason`, `banExpires`, `impersonatedBy`) are server-owned,
and `role` can never be supplied through input.

The normalized `Actor`, the capability helpers, the resource policies, the
administration area, and the audit trail are documented in
[`authorization-admin-access-control.md`](./authorization-admin-access-control.md).
Banning, impersonation, and user lifecycle management remain deferred, and the
`admin` role does not hold those capabilities.

## Migration ownership

```text
prisma/schema.prisma        generator and datasource only
prisma/identity.prisma      Better Auth models
prisma/migrations/20260731201511_establish_authentication_foundation
```

The models were generated with `auth generate` against the real configuration and
reviewed before being committed. They are owned by `src/platform/auth`;
application code must not query them directly.

The migration is additive: four `CREATE TABLE` statements, two unique indexes,
three plain indexes, and two foreign keys with `ON DELETE CASCADE`. It contains
no `DROP`, `TRUNCATE`, `DELETE`, extension, data backfill, or fixture credential.

It was applied to an empty database with `prisma migrate deploy`, verified with
`prisma migrate status`, and applied a second time to confirm it reports no
pending migrations. Table, column, constraint, index, and cascade metadata were
inspected directly in PostgreSQL.

## Why the proxy is not an authorization boundary

Proxy code runs before routes are rendered and can be deployed ahead of the
application runtime. It sees a URL, headers, and cookies, not verified identity.
Next.js also treats Server Functions as POST requests to their own route, so a
matcher change can silently remove coverage.

This change therefore adds no session hint and no optimistic redirect to the
proxy. `/login` is classified as `auth` and `/account` as `front-office` purely as
metadata. Every real decision stays in the page, the Route Handler, or the Better
Auth endpoint. See
[`proxy-request-pipeline.md`](./proxy-request-pipeline.md).

## Why client state is not authorization

`useSession` and any other client value can be replayed, edited, or fabricated.
The client is used only to start sign-in and sign-out and to render pending and
error state. Hiding a control is not authorization.

## Safe return-to policy

`resolveSafeReturnTo` accepts only an internal, locale-prefixed path. It rejects
absolute URLs, protocol-relative paths, backslash variants, percent-encoded
values, traversal segments, unsupported locale prefixes, and schemes such as
`javascript:`. Anything rejected falls back to `/{locale}/account`, so a
manipulated link cannot redirect a freshly authenticated visitor off-site.

Percent-encoded candidates are refused rather than decoded, which keeps the check
from ever having to reason about a value that only looks internal after decoding.

## Environment variables

```text
BETTER_AUTH_SECRET   server-only, at least 32 characters, no default
NEXT_PUBLIC_APP_URL  existing public application URL, reused as base URL
```

`BETTER_AUTH_SECRET` is added to the validated, strict server schema, so a
missing or short value fails at startup. It is never exposed through a
`NEXT_PUBLIC_` variable, never passed to a Client Component, and never logged.
Application code reads it only through `serverEnv`.

Automated runs inject a clearly labelled test-only value at the test boundary:
GitHub Actions job environment, the Playwright `webServer` environment, and
`tests/vitest.setup.ts`. Runtime code has no fallback.

## Testing strategy

| Layer       | Coverage                                                             |
| ----------- | -------------------------------------------------------------------- |
| Unit        | registration policy, safe return-to policy                           |
| UI          | login form and logout button against a mocked client boundary        |
| Integration | real PostgreSQL: sign-up, sign-in, session, revocation, admin fields |
| Contract    | architecture, configuration, routes, migration, localization, deps   |
| End-to-end  | Arabic and English journeys, cookies, and endpoint behavior          |

Integration tests use the real migration and the real Better Auth instance; the
library is not mocked. Every test creates a unique address, and cleanup is bounded
to the rows the file created — child rows before parent rows — and only after
asserting `APP_ENV=test` and a local database host.

End-to-end accounts are provisioned through Better Auth's own sign-up endpoint,
so no password hash is written by hand and no account is shared between flows.

Integration and end-to-end runs need the migrated test database:

```bash
pnpm db:test:up
pnpm db:migrate:deploy
```

## User provisioning in development

Create a development account through the same endpoint the tests use:

```bash
curl -X POST "$NEXT_PUBLIC_APP_URL/api/auth/sign-up/email" \
  -H 'content-type: application/json' \
  -H "origin: $NEXT_PUBLIC_APP_URL" \
  -d '{"email":"dev@example.test","password":"<local-only-password>","name":"Dev"}'
```

Promoting an account to `admin` is a database operation for now, because no
administrative interface exists yet.

## Production registration is disabled

Staging and production reject sign-up at the endpoint. Provisioning accounts in a
deployed environment is therefore an operational task until an invitation or
administrative flow is designed.

## Deferred

```text
email verification
password reset
social login
two-factor authentication
passkeys
account recovery
rate limiting policy and shared storage
Redis session cache
session and device management interface
full Actor normalization
business permissions
administrative dashboard
impersonation interface
audit logs
proxy session hints and optimistic redirects
```

## Related documentation

- [Proxy Request Pipeline](./proxy-request-pipeline.md)
- [Observability Foundation](./observability.md)
- [Layer and Module Boundaries](./layer-boundaries.md)
- [Module Map](./module-map.md)
- [Authentication implementation notes](../../src/platform/auth/README.md)
- [Database platform](../../src/platform/database/README.md)
- [Repository Rules](../../AGENT_RULES.md)
