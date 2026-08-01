# Server Action Factory

Every Server Action in this application is created by one factory. This document
records the contract that factory provides, the order it guarantees, and the line
it draws between the adapter and a use case.

## Why a factory

A Server Action is a public, unauthenticated network entry point. Written by hand,
each one repeats the same five obligations: parse an untrusted argument, resolve
the caller, require a capability, turn a failure into something safe to return,
and shape a result. Repeated five times, one of them is eventually written
differently, and that one is the vulnerability.

`defineAction` is where those obligations are implemented once. A definition
declares what it needs and supplies a use case; it does not restate the
mechanics, and the contract suite refuses a definition that does.

## Contract

```ts
import * as z from "zod";

import {
  AUTHORIZATION_MODE,
  defineAction,
} from "@/platform/actions/index.server";

export const publishProductAction = defineAction({
  name: "catalog.product.publish",
  input: z.object({ productId: z.string().min(1) }),
  authorization: { mode: AUTHORIZATION_MODE.ACTOR },
  execute: ({ input, actor }) => publishProduct(input.productId, actor.userId),
  hooks: {},
  revalidate: { paths: [{ path: "/catalog" }] },
});
```

The result is a typed Server Action:

```ts
(input: unknown) => Promise<ActionResult<Output>>;
```

The parameter is `unknown` because a Server Action argument crosses the network
and is untrusted until the schema has parsed it. The call resolves rather than
throws: every outcome, including a refusal, is an `ActionResult`.

| Field           | Purpose                                                      |
| --------------- | ------------------------------------------------------------ |
| `name`          | Stable identifier such as `catalog.product.publish`. Logged. |
| `input`         | Zod schema. Determines the input type of `execute`.          |
| `authorization` | One of the five declared modes.                              |
| `execute`       | The use case call. Determines the output type.               |
| `hooks`         | Optional `beforeExecute`, `afterSuccess`, `afterFailure`.    |
| `revalidate`    | Optional static paths and tags to invalidate after success.  |

## Authorization modes

```ts
{ mode: "public" }
{ mode: "actor" }
{ mode: "permission", permission: PERMISSION.IDENTITY_USER_SET_ROLE }
{ mode: "any-permission", permissions: [/* at least one */] }
{ mode: "all-permissions", permissions: [/* at least one */] }
```

The set is closed and there is no escape hatch: an Action either declares itself
public or names what the caller must hold.

- A permission is a `Permission` identifier from the registry, so an undeclared
  capability string does not compile.
- The two multi-permission modes take `readonly [Permission, ...Permission[]]`, so
  an empty list cannot be mistaken for "no requirement".
- The capability decision is delegated to `require-permission.server.ts`, which
  asks Better Auth using the actor's verified user id. The factory compares no
  role name.
- `public` reads no session at all: it never reaches the auth provider.

## Execution order

The order is fixed, and it is what lets a use case trust its arguments.

1. Validate the input.
2. Resolve the current actor, when the mode needs one.
3. Authenticate, then authorize.
4. Run `beforeExecute` hooks, in declaration order.
5. Run the use case.
6. Run `afterSuccess` hooks, then cache invalidation.
7. Return `actionSuccess`.

On failure:

1. Normalize the error through `toPublicError`.
2. Run `afterFailure` hooks.
3. Return `actionFailure`.

`execute` is unreachable when the input is invalid, when the actor is missing,
when the capability is missing, and when a `beforeExecute` hook throws.

Validation precedes authorization deliberately. A malformed argument is refused
before the auth provider is consulted, so a caller cannot use a Server Action as
an unauthenticated load generator against the session store.

## Typing

Nothing is restated that the schema or the use case already determines.

- The input type of `execute` is `z.output<TSchema>`, so a transform is reflected:
  a schema that maps `{ raw: string }` to `{ length: number }` gives `execute` the
  latter.
- The output type is inferred from `execute`.
- The Action's result type is `ActionResult<Output>`.
- The actor type is derived from the mode: `null` for `public`, and a guaranteed
  `Actor` for every other mode. A use case behind a capability never has to
  re-check whether a caller is signed in, and a public Action cannot be mistaken
  for an authenticated one.

Hook contexts are typed from the same two sources. `afterFailure` sees
`input: TInput | null` and `actor: TActor | null`, because a failure can precede
either.

## Validation

`safeParseAsync` is used, so a schema may carry a transform or an async
refinement.

A refusal becomes `VALIDATION_FAILED` and nothing else. The result carries a code
and no other key: no Zod issues, no message, no stack, no field name, no field
value, and no echo of the input.

Per-field form feedback is therefore not available from this contract yet. See
[Deferred constraints](#deferred-constraints).

## Error mapping

Every failure is normalized through the shared `toPublicError`, so an Action
returns exactly the codes the rest of the application already uses.

- An `ApplicationError` returns its own code.
- Anything else — an unexpected `Error`, a thrown string, a `null`, a Prisma or
  SQL error object — returns `INTERNAL_ERROR`.

A raw error never reaches the caller and never reaches a log line. This factory
introduces no error hierarchy of its own; the contracts live in
[`error-handling.md`](./error-handling.md).

## Hooks

Three hooks may be declared. The set is closed, and no hook can run before
validation or take part in the authorization decision.

| Hook            | Runs                                     | On failure                                          |
| --------------- | ---------------------------------------- | --------------------------------------------------- |
| `beforeExecute` | After authorization, before the use case | Prevents execution; becomes a normal failure result |
| `afterSuccess`  | Only after the use case succeeded        | Recorded; the success stands                        |
| `afterFailure`  | Only after a failure                     | Recorded; the original failure stands               |

- Hooks run sequentially, in declaration order.
- `beforeExecute` is the only hook that can stop execution.
- An observer hook cannot change the outcome. Each is isolated, so a failing
  observer neither hides the result nor prevents the observers declared after it.
- `afterFailure` receives the normalized `PublicError`, never the raw error, so a
  failure observer cannot read a message, a stack, or a provider payload.

## Logging

Logging is central to the factory and uses the existing observability API. There
is no `console` call anywhere in the adapter.

Events:

```text
server_action.started
server_action.succeeded
server_action.failed
server_action.hook_failed
```

A `server_action.failed` line is a warning for an expected refusal and an error
for an unexpected failure, matching `isExpectedApplicationError`.

The payload is an allowlist, closed in the type `ServerActionLogFields`:

```text
actionName
requestId
actorUserId
durationMs
outcome
errorCode
hookName
```

Widening that type is the only way to log a new field, which makes an accidental
payload leak a reviewed change rather than a typo. An actor is accepted whole and
reduced to its user id in one place, so the actor's name, email address, session
id, and roles are dropped once rather than once per call site.

Never logged: the input, the output, a `FormData` body, a password, a token, a
cookie, an authorization header, an email address, a display name, a raw error, a
stack trace, or a Zod issue.

`requestId` is read from the request context when one exists and omitted when it
does not. A Server Action outside the proxy matcher has no correlation value, and
a log line never claims to know something it does not.

## Audit and cache invalidation

The factory writes no audit record and knows no business resource. Auditing is
done by the Action definition, through an `afterSuccess` hook that calls the
appropriate audit service with allowlisted data:

```ts
hooks: {
  afterSuccess: [
    ({ actor, output }) =>
      recordAuthorizationAudit({
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId,
        action: AUDIT_ACTION.USER_ROLE_SET,
        targetUserId: output.targetUserId,
        requestId: null,
        metadata: buildRoleSetMetadata(output.role),
      }),
  ],
}
```

Cache invalidation is declared, not called:

```ts
revalidate: {
  paths: [{ path: "/admin/users" }, { path: "/catalog/[slug]", type: "page" }],
  tags: [{ identity: productCache.all() }],
  redis: [productCache.detail(productId)],
}
```

The invalidation system itself lives in `@/platform/cache` and is shared with the
Route Handler factory, so an Action and a route purge the same tags through the
same code. There is one invalidation system in the repository, not two.

- Invalidation runs only after the use case succeeded.
- Paths, tags, and Redis entries are declared in the Action definition and are
  never taken from client input, so a caller cannot ask the server to purge an
  arbitrary route or an unrelated tag.
- A tag is named by a `CacheIdentity`, not a string, so the Next.js tag and the
  Redis key are derived from one declaration and cannot drift.
- Nothing is invalidated after a validation, authorization, `beforeExecute`, or
  use case failure.
- `revalidateTag` is always called with the pinned two-argument signature. The
  default profile is `"max"`, which marks the tag stale and serves
  stale-while-revalidate. The deprecated single-argument form is never used.
- A Server Action is the **only** place `read-your-own-writes` is available. It
  calls `updateTag`, which expires the entry immediately so the user who just
  saved something sees it, and which Next.js permits only inside a Server Action.
- Every target is attempted. One failure does not cancel the rest.

**These post-success steps are not transactional with the use case.** By the time
they run, the mutation has committed. A completed mutation must not be reported
back as a retryable failure, because a retry would apply it twice — so an audit or
invalidation failure is recorded as a structured error and the success result
stands. The consequence is a lost audit record or a window of stale reads, never a
lost write. There is no reconciliation path for a lost record yet; the same
limitation is recorded in
[`authorization-admin-access-control.md`](./authorization-admin-access-control.md).

## Architectural separation

The Action adapter owns exactly seven concerns:

```text
validation
actor resolution
authorization
error normalization
lifecycle hooks
logging
ActionResult construction
```

It must not contain, and an ESLint boundary refuses:

```text
Prisma, a database client, a repository
a business module or a business rule
an HTTP response, a redirect, a cookie mutation
a module-specific permission or audit record
```

The only Next.js API the factory may import is `next/cache`. The factory calls
`execute` and nothing else; the use case owns the business logic.

### `"use server"`

A file that defines Server Actions must start with the directive:

```ts
"use server";
```

Such a file may only export async functions, so it must not also export a type, a
constant, or a non-async helper. A definition built by the factory satisfies this:
`defineAction` returns an async function.

The factory itself is not an Action file. It is marked:

```ts
import "server-only";
```

## Examples

### A public Action

```ts
"use server";

import * as z from "zod";

import {
  AUTHORIZATION_MODE,
  defineAction,
} from "@/platform/actions/index.server";

export const searchCatalogAction = defineAction({
  name: "catalog.product.search",
  input: z.object({ term: z.string().trim().min(2).max(80) }),
  authorization: { mode: AUTHORIZATION_MODE.PUBLIC },
  execute: ({ input }) => searchProducts(input.term),
});
```

`actor` is `null` here, and the type says so.

### A capability-protected Action

```ts
"use server";

import * as z from "zod";

import {
  AUTHORIZATION_MODE,
  defineAction,
} from "@/platform/actions/index.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";

export const setUserRoleAction = defineAction({
  name: "identity.user.role-set",
  input: z.object({
    userId: z.string().trim().min(1),
    role: z.enum(AUTHORIZATION_ROLE_NAMES),
  }),
  authorization: {
    mode: AUTHORIZATION_MODE.PERMISSION,
    permission: PERMISSION.IDENTITY_USER_SET_ROLE,
  },
  execute: ({ input, actor }) => setUserRole(input, actor),
  revalidate: { paths: [{ path: "/admin/users" }] },
});
```

`actor` is a guaranteed `Actor`, and the use case is unreachable without the
capability.

## What stays inside the use case

The factory deliberately does not know about any of this:

- Business rules, invariants, and domain validation beyond input shape.
- Persistence, repositories, and transactions.
- Which resource the caller is allowed to touch — an object-level policy is a
  resource decision and belongs with the resource, as `policies/` already does for
  authorization.
- Building the audit record's contents.
- Choosing which module owns the data.

An Action declares a capability. It does not decide whether _this_ caller may
touch _this_ row; that is the use case's decision, and it is made with the actor
the factory guarantees.

## Deferred constraints

Not implemented, and out of scope for this foundation:

- Field-level validation feedback. `VALIDATION_FAILED` carries no field detail, so
  a form cannot yet render per-field messages from an Action result.
- Dynamic invalidation. `revalidate` is static; a path derived from the use case
  output is not supported, which keeps a client-influenced string out of the cache
  API by construction.
- Automatic rate limiting, idempotency, or locking. The typed adapters exist in
  `@/platform/concurrency` and an Action definition may reach for them, but a
  control that applied itself to every Action would be a control nobody chose.
- Retries, transactions, queues, and an outbox.
- A form library binding, a React hook, a toast integration, and a redirect
  abstraction.
- Reconciliation for a lost post-success audit record.

## Related documentation

- [Error Handling Contracts](./error-handling.md)
- [Observability Foundation](./observability.md)
- [Authorization and Admin Access Control](./authorization-admin-access-control.md)
- [Route Handler Factory](./route-handler-factory.md)
- [Cache and Concurrency Controls](./cache-and-concurrency-controls.md)
- [Layer and Module Boundaries](./layer-boundaries.md)
- [Module Map](./module-map.md)
- [Implementation rules](../../src/platform/actions/README.md)
