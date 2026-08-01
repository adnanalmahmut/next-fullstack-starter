# Authorization and Admin Access Control

Server-side authorization built on the Better Auth Admin plugin with custom access
control. Every decision is a capability check against a declared permission; no
part of the application decides access by comparing a role name.

This document describes what is implemented. Deferred work is listed at the end
and is not present in the code.

## Permission naming

A permission name is always three lowercase segments:

```text
<module>.<resource>.<action>
```

`.` separates the segments, `-` may appear inside an action, and a role name never
appears in a permission. There is no wildcard: `*` and `identity.*.*` are not
permissions and cannot be granted.

The permissions this change introduces are the complete set:

| Permission                | Meaning                            |
| ------------------------- | ---------------------------------- |
| `identity.admin.access`   | Reach the administration area      |
| `identity.user.list`      | List users                         |
| `identity.user.read`      | Read one user                      |
| `identity.user.set-role`  | Replace a user's role              |
| `identity.session.revoke` | Revoke every session of a user     |
| `identity.audit.read`     | Read the authorization audit trail |

## Registry

`src/platform/auth/authorization/permission-registry.ts` is the single place a
permission is declared. It owns:

- `APPLICATION_STATEMENTS`, the Better Auth resources and actions.
- `Permission`, the union derived from those statements, so a name that is not
  declared is a type error.
- `PERMISSION`, the named constants every call site uses.
- The explicit flat-name to resource/action mapping.
- `toPermissionRequest`, which builds the Better Auth request.

Permission literals must not appear anywhere else. A contract test scans
`src/platform/auth/authorization` and `src/app` to prove it, and also proves the
registry and the statements agree in both directions.

`toPermissionRequest` fails closed. An empty list and an undeclared name both
produce `null`, which grants nothing; the failure is in the registry rather than
at the call site, so no caller can forget to handle it.

Better Auth resource keys:

```text
identity.admin     access
identity.user      list, read, set-role
identity.session   revoke
identity.audit     read
```

## Capability versus resource policy

A capability answers one question:

> May this actor perform this kind of operation at all?

A resource policy answers a different one:

> May this actor perform it on this record, in its current state?

The two are separate modules on purpose. The capability evaluator knows nothing
about records, and the policies know nothing about permissions. A contract test
asserts neither imports the other.

## Actor

`src/platform/auth/authorization/actor.ts` defines the normalized server-side
actor:

```ts
type Actor = {
  readonly userId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly email: string;
  readonly roles: readonly string[];
};
```

It deliberately carries no session token, cookie, IP address, user agent,
password or account data, ban metadata, and no resolved permission graph.

`roles` is descriptive context for logging and audit reasoning. It is never the
basis of a decision. An actor is only ever built from a session the server has
already verified, so a role can never arrive from request input.

## Role normalization

Better Auth stores a role in one column and represents multiple roles as a comma
separated list. `src/platform/auth/authorization/role.ts` owns the closed role
set and the parsing:

- Entries are trimmed, empty entries are dropped, duplicates collapse.
- An unrecognized entry is kept, so the value stays an honest description of what
  is stored. It grants nothing, because the evaluator finds no statements for it.
- A blank column produces an empty list. Better Auth then applies its configured
  default role, which holds no administrative capability.

`role.ts` and `access-control.ts` are the only modules allowed to name a role, and
`policies/` is the only other place allowed to reason about the admin role, for
the last-administrator rule. Everywhere else an ESLint rule
(`architecture/no-role-comparison`) refuses a role literal in an equality
comparison or a membership check, and a contract test proves the rule's role list
matches the role module.

## Centralized helpers

`src/platform/auth/authorization/actor.server.ts`:

```ts
getActorFromHeaders(headers): Promise<Actor | null>
getCurrentActor(): Promise<Actor | null>
requireActor(actor): Actor                        // throws UnauthenticatedError
```

`src/platform/auth/authorization/require-permission.server.ts`:

```ts
requirePermission(actor, permission): Promise<Actor>
requireAnyPermission(actor, permissions): Promise<Actor>
requireAllPermissions(actor, permissions): Promise<Actor>
resolveAuthorization(actor, permissions): Promise<AuthorizationOutcome>
```

Semantics:

- `requirePermission` requires one capability.
- `requireAnyPermission` succeeds when at least one is held.
- `requireAllPermissions` succeeds only when every one is held.
- No actor produces `UnauthenticatedError`; a missing capability produces
  `ForbiddenError`. Both come from `src/shared/errors`; no competing error
  hierarchy exists.
- The permission list is a non-empty readonly tuple, and an empty or undeclared
  request is refused at runtime as well.

`resolveAuthorization` is the non-throwing form. It exists for a Server Component
that must render a denied state instead of failing, and it evaluates the same
capability through the same code path. Every mutation and every API entry point
uses the throwing form.

The boolean helper behind all four is deliberately not exported, so a call site
cannot check a capability and then ignore the answer.

## How Better Auth decides

`requirePermission` and its siblings call the provider:

```ts
auth.api.userHasPermission({
  body: { userId: actor.userId, permissions: request },
});
```

The call passes the verified `userId` and no role. Better Auth loads the user and
reads the stored role itself, so the decision is made against the database on
every check, not against a session snapshot. An integration test proves this: an
actor built while its user was an administrator is refused as soon as the stored
role changes.

Inside the Better Auth guard hook the verified role is already in hand, so the
same roles are evaluated directly through `capability.ts`. It mirrors the
provider's semantics exactly: any held role may grant, every requested resource
and action must be granted within one role, a blank column falls back to the
default role, and an unrecognized role grants nothing.

## Least-privilege admin role

`src/platform/auth/access-control.ts` combines the Admin plugin's own statements
with the application statements and declares two roles.

`user` is granted nothing. Every statement is listed with an empty action set so
the intent is explicit rather than inferred from an omission.

`admin` is not the plugin's `adminAc`. It is granted only what this application
performs:

| Better Auth resource | Granted                   | Withheld                                                                                              |
| -------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `user`               | `list`, `get`, `set-role` | `create`, `update`, `delete`, `ban`, `impersonate`, `impersonate-admins`, `set-password`, `set-email` |
| `session`            | `list`, `revoke`          | `delete`                                                                                              |

Plus the six application capabilities.

`adminUserIds` and `allowImpersonatingAdmins` are not configured. No Admin client
plugin is added: every administrative operation runs on the server.

Because the withheld actions are what the plugin's own endpoints check, those
endpoints refuse an administrator as well. Integration tests call
`/api/auth/admin/create-user`, `/update-user`, `/remove-user`, `/ban-user`,
`/unban-user`, `/impersonate-user`, `/set-user-password`,
`/list-user-sessions`, `/revoke-user-session`, and `/stop-impersonating` with a
real administrator session and assert `403` for each.

## Server Component protection

`src/app/[locale]/(admin)/admin/layout.tsx` is the area boundary:

1. Validate the locale.
2. Build the actor on the server.
3. No session redirects to the localized sign-in page with a safe `returnTo`.
4. Require `identity.admin.access`.
5. Without it, render a localized denied state; the children are never rendered.

It never reads `useSession`, never consults a client value, and never depends on
the proxy.

`forbidden()` would give the page itself a real `403`, but in Next.js 16.2.12 it
is an experimental API behind the `authInterrupts` flag, and this change does not
enable a flag for it. The denied state therefore renders with a `200` status. The
authoritative refusal is the API, which answers `403`. Each administration page
also re-checks its own capability rather than relying on the layout, so a layout
change alone cannot expose a page.

## Route Handler protection

Every `/api/admin` handler is a public entry point. Each one:

- reads the session itself and builds the actor,
- requires its capability through the centralized helper,
- validates params, query, and body with Zod,
- calls the server service, never a duplicate of its logic,
- answers through the shared HTTP error contract,
- imports no Prisma client and no database module,
- compares no role, logs no body and no headers, and returns no provider error.

The capability is required before the target identifier is validated or loaded, so
an unauthorized caller is refused whether or not the target exists.

## Proxy

`src/platform/proxy/route-rules.ts` gains one rule:

```ts
{ pathname: "/admin", area: "admin", match: "subtree", localized: true }
```

That is classification metadata and nothing else. The proxy performs no session
lookup, holds no permission graph, and makes no authorization decision. Segment
matching keeps `/admin` distinct from `/administrator` and `/administer`, which a
contract test asserts.

## Object-level protection

The order is fixed, and it is the order that prevents disclosure:

1. Authenticate the actor.
2. Require the capability.
3. Validate the target identifier.
4. Load the target.
5. Apply the resource policy.
6. Execute.

Consequences:

- An unauthorized caller receives `403` whether the target exists or not.
- An authorized caller receives `404` for a target that does not exist.
- A resource policy can never disclose record state to a caller who has not
  passed the capability gate.

The guard hook applies the same order, and it deliberately leaves a missing target
to the endpoint so a refusal is never turned into a "not found".

## Supported administrative operations

```text
list users
get user
set user role
revoke every session of a target user
list recent authorization audit records
```

Each one goes through Better Auth (`listUsers`, `getUser`, `setRole`,
`revokeUserSessions`) or, for the audit trail, through the audit repository.
Nothing writes to a Better Auth owned table directly, and no provider record
reaches a response or a page: every result is an allowlisted DTO.

`AdminUserDto` carries `id`, `name`, `email`, `emailVerified`, `roles`, and
`createdAt`. Ban metadata, credentials, tokens, addresses, and user agents are not
part of it. Lists are bounded, sort fields come from an allowlist, and the single
searchable field is fixed, so a caller can never name a column or an operator.

## Set-role policy

`policies/set-role.policy.ts` is pure and receives already-loaded facts.

1. The requested value must be exactly one approved role. `superadmin`, `Admin`,
   `admin,user`, `admin,admin`, an empty string, an array, and a null all fail as
   invalid input (`400`).
2. Removing the admin role from the only remaining administrator is a conflict
   (`409`).
3. Changing your own role is refused (`403`).

The conflict is checked before the self rule on purpose. Only an administrator
holds `identity.user.set-role`, so the only way to reach the last administrator as
a target is to be that administrator. "You are the last administrator" is both the
accurate reason and the more useful one; a self change while another administrator
remains still stops at step 3.

The operation replaces the stored role with one approved role. No multi-role
assignment interface exists.

The administrator count is read with a whole-entry match on the role column, so a
longer name that merely contains the admin role is not counted. The check is not
transactional: two concurrent demotions could both observe another administrator.
The window is small and both callers must already be administrators; closing it
needs a database-level guarantee and is deferred.

## Revoke-sessions policy

`policies/revoke-sessions.policy.ts` refuses revoking your own sessions through the
target-user operation, so an administrative action cannot sign the administrator
out as a side effect. Self-service session management is a separate feature.

The target is a user identifier taken from the path. A session token supplied by a
caller is never accepted as the subject, and the acting identity is never read from
a body or a query string.

## Direct Better Auth endpoint protection

The Admin plugin endpoints are reachable at `/api/auth/admin/...`, so protecting
`/api/admin` is not enough.

Better Auth runs `hooks.before` and `hooks.after` for a router request and for a
direct `auth.api.*` call alike. `authorization/admin-guard.server.ts` uses that to
apply, in one place:

- an allowlist of admin paths, so an unlisted path is refused by construction,
  including an endpoint a future Better Auth version might add,
- the application capability for the endpoint,
- Zod validation of the parts of the body the policies need,
- the resource policies, before any mutation,
- the audit record, after a mutation actually succeeded.

The allowlist:

| Path                          | Capability                | Audited                    |
| ----------------------------- | ------------------------- | -------------------------- |
| `/admin/list-users`           | `identity.user.list`      | no                         |
| `/admin/get-user`             | `identity.user.read`      | no                         |
| `/admin/set-role`             | `identity.user.set-role`  | `identity.user.role-set`   |
| `/admin/revoke-user-sessions` | `identity.session.revoke` | `identity.session.revoked` |

`/admin/has-permission` is exempt. Better Auth refuses it outright when a request
carries no valid session, and over HTTP it only ever reports on the caller's own
session; the application's capability helpers call it without headers, so
requiring a capability there would make every capability check recursive.

Because the hook covers direct `auth.api.*` calls too, the application services
simply call `auth.api.setRole` and `auth.api.revokeUserSessions`. The capability
check, the policy, and the audit record are applied once and cannot be skipped.

No spoofable internal header and no custom signature is used to tell an internal
call from an external one. The distinction is not needed: both take the same path.

A refusal is translated into Better Auth's own error type so a direct caller
receives the correct status. An unexpected failure is rethrown untouched, so it is
logged rather than disguised as a chosen status. One consequence is that a direct
`auth.api.*` call with `asResponse: true` now rejects instead of resolving to an
error response; over HTTP the router turns the same refusal into the right status.

## Audit trail

`prisma/authorization.prisma` owns `AuthorizationAuditRecord`, mapped to
`authorization_audit_record`.

| Column           | Notes                                                |
| ---------------- | ---------------------------------------------------- |
| `id`             | Primary key                                          |
| `occurredAt`     | Database default `CURRENT_TIMESTAMP`                 |
| `actorUserId`    | Who performed the change                             |
| `actorSessionId` | Stored for investigation, never exposed to a reader  |
| `action`         | Database enum, labelled with the stable action names |
| `targetUserId`   | Which user the change was about                      |
| `requestId`      | Optional, taken from `x-request-id` when propagated  |
| `metadata`       | Optional, allowlisted shape only                     |

Audited actions:

```text
identity.user.role-set
identity.session.revoked
```

Only a mutation that actually succeeded is recorded, exactly once, whether it came
through `/api/admin` or through `/api/auth/admin`. Reads are not audited.

### Data minimization

Allowlisted metadata is the whole surface:

```json
{ "role": "user" }
{ "role": "admin" }
{ "scope": "all" }
```

Never stored: a password or password hash, a session token, a cookie, an
authorization header, an email address, a display name, an IP address, a user
agent, a raw request body, a raw provider error, a stack trace, or arbitrary
metadata. Metadata is built by pure builders and validated again on read, so a
value written by an unexpected path cannot reach a caller.

### Properties

The trail is append-only from the application's perspective. The repository
exposes one append and one bounded, newest-first read; there is no update, no
delete, and no export. There is no foreign key to `user` or `session`, so a record
outlives what it refers to and no cascade can remove it.

Indexes exist for the queries that are actually run:

```text
(occurredAt)                  the newest-first listing
(actorUserId, occurredAt)     what did this administrator do
(targetUserId, occurredAt)    what happened to this user
```

### When the record cannot be stored

A completed administrative change must not be reported back as a retryable
failure, because retrying would apply it twice. So a storage failure is recorded
as a high-severity structured error carrying the action, the actor id, the target
id, the request id, and a safe error code, and the operation still succeeds.

The known limitation: a lost record leaves no application-level reconciliation
path. There is no queue and no outbox for it yet. Closing that gap means writing
the record in the same transaction as the change, which the provider's endpoint
does not expose today, or adding an outbox; both are deferred.

## Migration

```text
prisma/migrations/<timestamp>_establish_authorization_admin_access_control
```

Additive only:

- `CREATE TYPE "authorization_audit_action"` with the two action labels.
- `CREATE TABLE "authorization_audit_record"`.
- Three `CREATE INDEX` statements.

No `DROP`, no `TRUNCATE`, no `DELETE`, no `UPDATE`, no `INSERT`, no data backfill,
no foreign key, and no change to a Better Auth owned model. The earlier migration
is untouched.

It was created against a disposable test database with `migrate dev
--create-only`, reviewed line by line, then applied with `migrate deploy`. A
second `migrate deploy` reports no pending migrations, and a fresh database
applies both migrations from scratch.

## Initial administrator provisioning

There is no bootstrap endpoint, no secret bootstrap URL, no administrator email
environment list, no `adminUserIds`, no first-user-is-an-administrator behavior,
and no automatic elevation in any environment.

Creating the first administrator is a deployment or operator task, performed
against the database outside the application. It is intentionally not part of this
change, and no production elevation script is provided.

Tests create a user through Better Auth and then assign the role directly, in a
fixture that first proves it is pointed at a local test target.

## Logging

Stable event names:

```text
authorization.access.denied
authorization.audit.write_failed
authorization.admin.operation_completed
```

A log line may carry `actorUserId`, `targetUserId`, an action, a permission, a
request id, and a safe error code. It never carries a password, a session token, a
cookie, an authorization header, a raw body, an email address, a display name, a
full URL with its query, a raw provider error, or Prisma error metadata.
`console` is not used.

## Test strategy

| Level       | What it proves                                                                                                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | The registry, role normalization, actor normalization, capability semantics, both policies, the audit builders and allowlist, the endpoint allowlist, the DTOs, the query schemas, and the error mapping                                           |
| Integration | Real PostgreSQL and the real Better Auth instance: actors from real sessions, capability enforcement, every supported operation, both policies, session revocation, the audit trail, the direct plugin endpoints, and object-level response parity |
| Contract    | The architecture boundaries, the access-control shape, the endpoint allowlist, the audit model and migration, the route and page surface, localization, and the absence of role comparisons and permission literals                                |
| UI          | The administration presentation in Arabic RTL and English LTR, including the denied state and the absence of sensitive fields                                                                                                                      |
| E2E         | Both locales end to end: a normal user refused, an administrator performing every supported operation, every refusal, and the earlier authentication behavior still intact                                                                         |

## Deferred work

- Creating, deleting, banning, or impersonating a user; changing a password or an
  email address; editing a profile.
- Organizations and tenants.
- Business-module permissions.
- A Redis permission cache.
- An administration dashboard with metrics, and mutation controls in the UI.
- Email notifications for administrative changes.
- Audit export and retention.
- A transactional or outbox-backed audit write, and reconciliation for a lost
  record.
- A `defineRoute` factory with rate limiting, idempotency, and request logging.
- A real 403 status for the administration pages, which needs the
  `authInterrupts` flag.
- Self-service session management for a user's own sessions.
- A database-level guarantee for the last-administrator rule.
