# Route Handler Factory

Every HTTP endpoint the application owns is built by one adapter,
`defineRoute`, in `src/platform/http`. A `route.ts` declares what an endpoint
needs and what it does; request correlation, validation, authentication,
authorization, hook orchestration, error mapping, response serialization, and
request logging are implemented once, in the factory.

The rule this exists to enforce is simple: **a use case never touches the
transport, and an endpoint never repeats the boundary.** A handler that reads its
own body, checks its own capability, and catches its own errors is five handlers
that can each be wrong in a different way.

## Contract

```ts
export const GET = defineRoute({
  name: "identity.user.list",
  input: {
    params: paramsSchema,
    query: querySchema,
    body: bodySchema,
  },
  authorization: {
    mode: AUTHORIZATION_MODE.PERMISSION,
    permission: PERMISSION.IDENTITY_USER_LIST,
  },
  successStatus: 200,
  execute: async ({ params, query, body, actor, requestId }) =>
    listUsers({ actor }, query),
});
```

`defineRoute` returns a handler with the signature Next.js calls:

```ts
(request: NextRequest, context: { params: Promise<unknown> }) =>
  Promise<Response>;
```

`params` is `unknown` because a path segment is client-controlled text until a
schema has parsed it.

## Typing

Nothing in a definition restates a type the schema or the use case already
determines.

| Value           | Source                                                       |
| --------------- | ------------------------------------------------------------ |
| `params`        | `z.output` of the declared `params` schema, else `undefined` |
| `query`         | `z.output` of the declared `query` schema, else `undefined`  |
| `body`          | `z.output` of the declared `body` schema, else `undefined`   |
| `actor`         | `null` for a public route, `Actor` for every other mode      |
| `requestId`     | always `string`                                              |
| response output | inferred from `execute`                                      |

Because the value is the schema's _output_, a transform or a coercion has already
been applied. Because an undeclared part is typed `undefined`, a route cannot read
a part it never described. Because the actor type follows the declared mode, a use
case behind any protected mode never re-checks whether a caller is signed in, and
a public route cannot accidentally be treated as an authenticated one.

The two multi-permission modes take a non-empty tuple, so an empty list does not
compile and cannot be mistaken for "no requirement".

## Authorization modes

The modes are owned by `src/platform/auth/authorization/authorization-mode.ts`
and shared with the Server Action factory, so a capability means the same thing on
a form submission and on an HTTP request.

| Mode              | Requirement                       |
| ----------------- | --------------------------------- |
| `public`          | none; `actor` is `null`           |
| `actor`           | a verified session                |
| `permission`      | one registry capability           |
| `any-permission`  | at least one of a non-empty tuple |
| `all-permissions` | every one of a non-empty tuple    |

There is no "skip" and no escape hatch. A permission is always a `Permission`
identifier from the registry; a literal capability string does not compile. The
decision is delegated to the central gate, which asks Better Auth with the
verified user id, so the role is read from the database rather than from a session
snapshot. No role name is ever compared.

## Execution order

The order is fixed and is the reason a use case can trust its arguments.

1. Resolve or create the request id, and open the request context.
2. Log `route.started`.
3. Run the rate-limit hooks.
4. Validate `params`, `query`, and `body`.
5. Resolve the actor, when the mode needs one.
6. Authenticate, then authorize.
7. Begin the idempotency lifecycle, then run `beforeExecute`.
8. Run the use case.
9. Complete the idempotency reservation.
10. Run `afterSuccess`, then cache invalidation, then `audit`.
11. Serialize the envelope.
12. Log the completion.

A failure before the use case commits runs the reverse of step 9 — the reservation
is aborted — then `afterFailure`, then the safe response.

Steps 9 and 10 all run after the mutation has committed and none of them can be
rolled back, so their order is deliberate. **Completion first**, because it is the
only post-success step whose absence changes what a _client_ observes on a retry.
**Invalidation before audit**, because invalidation is what the next reader sees
and audit is what an operator reads later. **Audit last**, because it is the step
most likely to grow and growth there must not delay the two steps that affect
correctness.

Authorization always precedes the use case and any resource lookup, so a caller
without the capability is refused whether or not the target exists — an authorized
caller gets a genuine `404`, an unauthorized one never learns that an identifier
is real.

`execute` is unreachable when a rate limit refuses, when any part is invalid, when
the actor is missing, when the capability is missing, when idempotency reports a
conflict or a replay, when a control a definition declared as `required` is
unavailable, and when a `beforeExecute` hook throws.

## Validation

Each part is validated independently, with `safeParseAsync`, so a schema may carry
a transform or an async refinement.

- A part with no schema is never read. An undeclared body is not consumed and an
  undeclared query is not collected.
- The body is read exactly once, in one place. Malformed JSON, and an absent body
  where one was expected, both become `VALIDATION_FAILED`.
- The query preserves repeated keys. `?role=a&role=b` reaches the schema as an
  array rather than as an arbitrarily chosen one of the two values, so a schema
  expecting a single string refuses it instead of silently accepting half the
  input.
- Nothing is trusted before validation — not a path segment, not a search
  parameter, not a body.
- A refusal is opaque. The response carries a code and nothing else: no Zod issue,
  no field name, no supplied value.

`multipart/form-data` is not supported by this factory.

## Response envelope

Every answer under `/api/v1` is one of two JSON shapes:

```json
{ "data": {} }
```

```json
{ "error": { "code": "STABLE_ERROR_CODE" } }
```

- There is no `204`. A route with no payload answers `200` with `{"data": null}`,
  so a client parses one shape for every outcome.
- The success status is declared statically in the route (`200` or `201`). It is
  never chosen by client input and never returned by a use case.
- Every response carries `x-request-id`, on success and on failure alike.
- No message, stack, provider payload, or database detail ever reaches a body.
- An unexpected failure becomes `INTERNAL_ERROR` and `500`.

## Error mapping

The mapping is the central one in `src/platform/http/http-response.ts`; the
factory adds no second table.

| Code                     | Status |
| ------------------------ | ------ |
| `VALIDATION_FAILED`      | 400    |
| `UNAUTHENTICATED`        | 401    |
| `FORBIDDEN`              | 403    |
| `NOT_FOUND`              | 404    |
| `CONFLICT`               | 409    |
| `RATE_LIMITED`           | 429    |
| `DEPENDENCY_UNAVAILABLE` | 503    |
| `INTERNAL_ERROR`         | 500    |

`RATE_LIMITED` was added with this factory because the rate-limit hook needs to
refuse with an answer a client can act on, and a limiter that answered `403` would
be lying about why. `CONFLICT` covers an idempotency conflict.

`DEPENDENCY_UNAVAILABLE` was added with the concurrency controls, for the case
where a control a definition declared as `required` could not run. It is a 503
rather than a 500 because the request was refused _before_ anything ran: nothing
was written and the identical request may be retried. Telling a caller to slow
down when the truth is that a dependency is down would be an answer it cannot act
on, so an unavailable limiter with a `deny` fallback answers this and not `429`.

A `429` carries `Retry-After`, in seconds, rounded up. The value comes from a
number the rate-limit hook returned; the hook never builds a response, chooses a
status, or sets a header of its own.

## Hooks

Five typed extension points, run sequentially in declaration order within each
list. The set is closed: a hook cannot be added by a call site, cannot move within
the order, and cannot take part in the authorization decision.

| Hook            | Runs                         | Can stop the request |
| --------------- | ---------------------------- | -------------------- |
| `rateLimit`     | before authentication        | yes, with `refused`  |
| `beforeExecute` | last before the use case     | yes, by throwing     |
| `afterSuccess`  | after the use case committed | no                   |
| `audit`         | after cache invalidation     | no                   |
| `afterFailure`  | after a refusal or a failure | no                   |

Two further steps are the factory's own rather than declarable hooks, and are
named `idempotency` and `cacheInvalidation` in a `route.hook_failed` line.

- `rateLimit` runs first on purpose: refusing an over-limit caller must not
  require reading a session or a body. It returns a decision rather than throwing,
  so the factory owns the refusal and every limiter answers the same code. The
  decision may carry `retryAfterMs`, which is the entire allowlist of response
  metadata a hook may contribute.
- `afterSuccess` is where a definition records anything else it needs to.
- `audit` is named separately so an audit intent is visible in a definition and a
  failing audit is attributed to `audit` rather than hidden among other
  post-success work.
- `afterFailure` receives the normalized `PublicError` only, never the raw thrown
  value.

Observers are **not transactional** with the use case. The mutation has already
committed when they run, so a throwing observer is recorded as
`route.hook_failed` and the success response stands; a committed mutation is never
turned into a failure a client would retry. The observers declared after a failing
one still run.

The factory writes no audit record of its own. What is worth auditing is a
business decision and belongs to the definition.

## Idempotency

`idempotency` is a lifecycle rather than a hook, because a lookup separate from
its completion leaves a window in which a retry finds nothing and runs the
operation twice. A definition supplies one coordinator; two would each claim a key
and neither would know about the other's reservation.

`begin` runs _after_ authorization on purpose: a replayed answer must not be
served to a caller who is not allowed to have it. It answers `proceed`, `replay`,
or `conflict`. A `replay` carries a typed output rather than a `Response`, so a
replayed answer has exactly the same envelope, status, and correlation header as
the original, and is logged as `route.replayed`.

A `proceed` may carry a reservation with `complete` and `abort`. The factory calls
`complete` after the use case succeeds and `abort` after it fails, and holds the
reservation in a local — there is no shared map and nothing outlives the request.
A `proceed` without a reservation is the degraded path a `best-effort` policy
takes when the store is unreachable.

## Cache invalidation

A route declares `revalidate` the way an Action does, and the factory runs it
after `afterSuccess`. It uses the same invalidation system, so a route and an
Action purge the same tags through the same code.

A Route Handler may not declare the `read-your-own-writes` tag strategy:
`updateTag` is a Server Action API, and a definition that declares it is refused
when the route is _defined_, at module load, rather than in the post-success step
where the mutation has already committed.

The Redis-backed limiter, idempotency store, and lock live in
`@/platform/concurrency` and are documented in
[`cache-and-concurrency-controls.md`](./cache-and-concurrency-controls.md). No
endpoint in this repository declares one: a definition that declares no hook is
never limited and never replayed.

## Logging

Events are stable, language-neutral identifiers:

```text
route.started
route.succeeded
route.failed
route.hook_failed
route.replayed
```

A line may carry only these fields, and the type that declares them is closed —
widening it is the only way to log a new one:

```text
routeName  method  requestId  actorUserId  durationMs  statusCode  errorCode  hookName  replayed
```

Never logged: the body, a query value, a params value, the output, a password, a
token, a cookie, an authorization header, an email address, a name, the full URL,
a raw error, a stack trace, or a Zod issue. `console` is not used.

A refused request is logged at `warn` — it is expected traffic. An unexpected
failure is logged at `error`.

## Request id

The factory resolves the correlation id before anything else, from the incoming
`x-request-id`, reusing a client-supplied value only when it satisfies the bounded
UUID v4 contract and creating one otherwise. It opens the request context with it,
so every line of the request correlates, and it writes it on the response. The
proxy already applies the same contract at the edge; the factory does not depend
on having been reached through it.

## Caller credentials

Better Auth decides an administrative operation from the acting session, which it
reads from headers — for a router request and a direct `auth.api.*` call alike.
That is what makes the guard hook, the resource policies, and the audit record
impossible to skip, and it means a server service delegating to Better Auth needs
the caller's headers.

A use case must not be handed them: headers carry the session cookie, and a use
case that can read those can authenticate on its own. So the factory opens a
request-scoped store,
`src/platform/auth/authorization/caller-headers.server.ts`, and a delegating
service reads its credentials from there rather than from its arguments. Outside a
request there is no caller and the read fails closed as `UNAUTHENTICATED`.

This is credential propagation, not an ambient actor. The actor is still built by
verifying the session, and the capability is still evaluated by the central gate.

## Boundaries

The factory owns request context, validation, authentication, authorization, hook
orchestration, error normalization, response serialization, and request logging —
and nothing else.

It must not reach Prisma, a database client, a repository, a business module, a
business policy, a module-specific permission, a module-specific audit record,
React, translations, UI, a redirect, a cookie mutation, a queue, or Redis.
`next/server` is the only Next.js import it may take, and only for the request
type. An ESLint boundary and the contract suite enforce all of this.

A route definition may call a use case or a service. It must not contain business
logic, a duplicated `try`/`catch`, a direct `request.json()`, direct Zod parsing,
a direct capability check, a direct `jsonSuccess`/`jsonError`, Prisma, or a role
comparison. A separate ESLint block over `src/app/api/v1/**/route.ts` refuses each
of those, and the contract suite proves every versioned endpoint is a thin
adapter.

## API surface

Application endpoints are versioned under `/api/v1`:

```text
GET   /api/v1/admin/users
GET   /api/v1/admin/users/[userId]
PATCH /api/v1/admin/users/[userId]/role
POST  /api/v1/admin/users/[userId]/sessions/revoke
GET   /api/v1/admin/audit
```

`/api/auth/[...all]` is the one deployed path outside `/api/v1`; it is owned by
Better Auth and is never wrapped in the factory. The routes under
`/api/diagnostics` are development and test instrumentation, answer `404`
elsewhere, and are not part of the API.

The versioning and description strategy is recorded in
[ADR 1](../adr/0001-versioned-api-and-openapi-strategy.md).

## Deferred

Not implemented here, and deliberately so:

- `multipart/form-data` and file upload.
- An OpenAPI generator, a specification file, and a generated client.
- HTTP response caching and `Cache-Control` on the transport boundary. Cache-tag
  invalidation is implemented; caching the HTTP response itself is not.

## Related documentation

- [Cache and Concurrency Controls](./cache-and-concurrency-controls.md)
- [Server Action Factory](./server-action-factory.md)
- [Error Handling Contracts](./error-handling.md)
- [Observability Foundation](./observability.md)
- [Authorization and Admin Access Control](./authorization-admin-access-control.md)
