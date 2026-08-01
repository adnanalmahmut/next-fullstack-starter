# 1. Versioned HTTP API and OpenAPI strategy

- Status: Accepted
- Date: 2026-08-01

## Context

The application now builds every HTTP endpoint through one Route Handler
factory. That makes two questions answerable in one place, and worth deciding
before more endpoints exist.

The first is where the API lives. Until now the administration endpoints sat at
`/api/admin`, with no version segment. A path without a version has no room for a
breaking change: the only ways out are to break existing callers or to invent a
parallel naming scheme later, under pressure.

The second is how the API is described. A published description is genuinely
useful — for client generation, for contract testing, for review — and it is also
the easiest artefact in a repository to let rot. A handwritten document drifts
from the code the first time a schema changes and nobody remembers to edit it,
and a drifted description is worse than none: it is trusted and wrong.

## Decision

`/api/v1` is the current public version of the application's HTTP API.

- Every application endpoint lives under `/api/v1`. There is no unversioned
  application endpoint and no legacy alias: the project is a starter with no
  published API and no external caller, so the move is made outright rather than
  carried as a duplicate surface.
- `/api/auth/[...all]` is the one deployed path outside `/api/v1`. It is owned by
  Better Auth, which validates, authorizes, and serializes its own endpoints, and
  the application's guard hook already applies the capability, the resource
  policies, and the audit record to them. It is not wrapped in the factory.
- The diagnostics under `/api/diagnostics` are not application endpoints. Each
  answers `404` outside development and test and exists to prove a property of
  the infrastructure rather than to serve a client.

The description of that API is derived from code, not written beside it.

- Zod schemas are the single runtime validation source. A route declares one
  schema per part — params, query, body — and the factory validates against
  exactly those. There is no second description of a request shape.
- The response envelope and the error codes come from the central contracts:
  `HttpResponse` in `src/platform/http/http-response.ts`, `ERROR_CODE` in
  `src/shared/errors/error-code.ts`, and the status mapping between them. Every
  endpoint answers `{"data": …}` or `{"error": {"code": …}}`, so the response
  half of a specification is one shape and one enumerated code list, not a
  per-endpoint decision.
- Every route declares a `name` such as `identity.admin.users.list`. Names are
  unique and stable, and a contract test enforces both. That is deliberate: the
  operation id is the one part of a generated specification that must not change
  when a file moves, and choosing it now costs nothing.

No OpenAPI generator dependency is added in this change, and no specification
file is committed.

## Alternatives

**Keep `/api/admin` and version later.** Rejected. Versioning is cheap now and
expensive once a caller exists; there is no caller today.

**Keep a legacy alias at `/api/admin`.** Rejected. Two paths to the same handler
is two surfaces to secure, test, and document, for a starter whose API nobody
consumes yet.

**Hand-write an OpenAPI document now.** Rejected. It would duplicate every schema
and every error mapping the code already holds, and it would be wrong the first
time a schema changed without it. A specification that can disagree with the code
is a liability.

**Add a generator now.** Deferred rather than rejected. The value is real, but the
choice of tool determines how much of the description has to be restated by hand,
and that is the whole question. Generation is taken up when a tool is chosen that
derives the operation, its parameters, and its responses from the Zod schemas and
the route declarations that already exist — including the shared envelope — rather
than asking for a parallel set of annotations. Until then the schemas, the
envelope, the error codes, and the route names are kept in a shape a generator can
read.

## Consequences

- A client depends on `/api/v1`. A future breaking change introduces `/api/v2`
  beside it rather than altering a live shape.
- Adding an endpoint means adding a route name, and the contract suite fails if
  it collides with an existing one.
- Widening the response contract — a new error code, a new status — is a change
  to a central file with its own tests, not a per-route decision.
- There is no machine-readable description of the API in this change. A consumer
  reads the route definitions and the two contract files.

## Rollback

The decision is a directory layout plus a naming rule; nothing depends on it at
runtime. Moving the tree back under an unversioned path and deleting this record
would undo it, at the cost of reintroducing the versioning problem. No migration,
no stored data, and no external contract is involved.
