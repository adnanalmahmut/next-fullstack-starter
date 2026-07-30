# Error Handling Contracts

This document defines the implemented application error and transport result
contracts. The contracts are framework-independent, language-neutral, and safe
to serialize.

## Internal and public errors

Internal application failures use `ApplicationError` and its typed subclasses
from `src/shared/errors`. Each error carries:

- A stable `ErrorCode`.
- An internal diagnostic message.
- An optional `cause`.
- Standard `Error` identity and prototype behavior.

The diagnostic message and cause are server-side implementation details. They
must never be treated as translated presentation text or returned to a client.
The shared placement allows domain and application layers to use typed errors
without importing `src/platform` or a transport framework.

Public failures use the minimal `PublicError` contract:

```ts
type PublicError = {
  code: ErrorCode;
};
```

It intentionally contains no message, stack, cause, metadata, provider error,
database detail, or arbitrary exception value.

## Stable error codes

The initial closed set is:

| Code                | Meaning                                      |
| ------------------- | -------------------------------------------- |
| `VALIDATION_FAILED` | Accepted input failed application validation |
| `UNAUTHENTICATED`   | No authenticated actor is available          |
| `FORBIDDEN`         | The actor cannot perform the operation       |
| `NOT_FOUND`         | The requested resource is unavailable        |
| `CONFLICT`          | The operation conflicts with current state   |
| `INTERNAL_ERROR`    | The failure is not safe to classify publicly |

Codes are serialized identifiers, not HTTP status names or translation keys
containing user-facing text. Existing code meanings must not be repurposed.

## Normalization boundary

`toPublicError` in `src/platform/errors` is the only implemented conversion
from `unknown` to `PublicError`.

- A known `ApplicationError` preserves its declared code.
- Every other value becomes `INTERNAL_ERROR`.
- Objects are not trusted merely because they have `code`, `message`, or
  provider-shaped properties.
- The input is never cast, spread, or serialized into the result.

Logging is intentionally not part of normalization. A later observability
boundary may record internal diagnostics without changing the public contract.

## Action result contract

`src/platform/actions/action-result.ts` provides a boolean-discriminated result:

```ts
type ActionResult<T, E extends PublicError = PublicError> =
  { ok: true; data: T } | { ok: false; error: E };
```

`actionSuccess` and `actionFailure` construct the two shapes consistently.
The generic error parameter allows a future boundary to add explicitly safe
validation details while the default error remains code-only.

No Server Action factory or React form integration is implemented.

## HTTP response contract

`src/platform/http/http-response.ts` defines:

```ts
type HttpSuccessResponse<T> = { data: T };
type HttpErrorResponse<E extends PublicError = PublicError> = { error: E };
```

The exhaustive status mapping is:

| Error code          | HTTP status |
| ------------------- | ----------: |
| `VALIDATION_FAILED` |         400 |
| `UNAUTHENTICATED`   |         401 |
| `FORBIDDEN`         |         403 |
| `NOT_FOUND`         |         404 |
| `CONFLICT`          |         409 |
| `INTERNAL_ERROR`    |         500 |

The mapping uses `Record<ErrorCode, HttpErrorStatus>`, so adding a code without
adding a status is a TypeScript error.

No Route Handler factory or API route is implemented.

## Localization boundary

Error contracts contain no user-facing text. Presentation maps stable codes to
feature-scoped `next-intl` translation keys. Domain, application, Action
results, and HTTP responses must not choose English, Arabic, or any other
localized message.

## Correct usage

Application code may throw a diagnostic typed error:

```ts
throw new NotFoundError("Product lookup returned no record");
```

An adapter converts the caught value before creating a transport result:

```ts
const error = toPublicError(caught);
return actionFailure(error);
```

Presentation translates the code:

```ts
const message = t(`errors.${result.error.code}`);
```

## Prohibited usage

Do not return, serialize, or spread internal errors:

```ts
return { ok: false, error: caught };
return { error: { ...caught } };
return { error: { code: caught.code, message: caught.message } };
```

Do not infer a trusted code from an arbitrary object:

```ts
return { code: input.code as ErrorCode };
```

These patterns can expose stack traces, SQL, Prisma metadata, filesystem paths,
provider details, secrets, or internal diagnostic messages.

## Adding an error code

Adding a code is a public contract change:

1. Confirm a concrete application category requires a distinct stable code.
2. Add the language-neutral value to `ERROR_CODE`.
3. Add or update the corresponding typed application error.
4. Add an HTTP status to the exhaustive mapping.
5. Add unit and contract coverage for normalization and serialization.
6. Add presentation translations only when a rendered user flow uses the code.
7. Update this document without changing the meaning of existing codes.

Do not add business-specific, provider-specific, or speculative codes to the
shared set.

## Deferred work

The following remain intentionally outside this contract:

- Server Action and Route Handler factories.
- Authentication, authorization policies, and business modules.
- Structured logging, request context, tracing, and monitoring.
- Request IDs, field-error schemas, pagination, metadata, and OpenAPI.
- UI components and translated user-facing messages.
