# Proxy Request Pipeline

Implementation of the request pipeline that `src/proxy.ts` composes.

The architectural policy, matcher matrix, deferred work, and the reasons the
proxy is not an authorization boundary are documented in
[`docs/architecture/proxy-request-pipeline.md`](../../../docs/architecture/proxy-request-pipeline.md).

## Files

```text
compose.ts                     runs the steps in a fixed order
context.ts                     per-request data a step may read
route-classifier.ts            pure pathname-to-area classification
route-rules.ts                 immutable route area declarations
steps/request-id.step.ts       correlation ID forwarding and return
steps/locale.step.ts           next-intl negotiation and locale cookie sync
steps/security-headers.step.ts baseline response security headers
```

## Pipeline order

```text
request-id (request) -> classify -> locale -> security headers -> request-id (response)
```

The correlation ID is written on the request headers before the locale step runs,
because `next-intl` copies the request headers into the response it creates. That
is how the value reaches server handling.

## Rules for changes

- Keep `src/proxy.ts` a composition file. Logic belongs in a step.
- Add a step only when the concern is genuinely request-wide. This is not a
  generic middleware framework.
- Mutate the response the locale step returns. Do not rebuild a response from an
  existing body: status, `Location`, rewrite metadata, cookies, and internal
  headers would be lost.
- Forward upstream headers with `NextResponse.next({ request: { headers } })`.
  `NextResponse.next({ headers })` exposes them to the client.
- Declare a route rule only for a route that exists in `src/app`. Unimplemented
  areas stay `unknown` until their own feature adds a rule.
- Keep the classifier pure. It must not read cookies, produce a response, or
  decide authorization.
- Do not read a session cookie, resolve an actor, compare roles, or return `401`
  or `403` from here.
- Reuse `REQUEST_ID_HEADER` and `resolveRequestId` from
  `@/platform/observability/request-id.server` instead of defining a second
  contract.
- Add a security header only with a documented policy decision. The current
  baseline is intentionally minimal.

## Enforcement

- ESLint restricts imports for `src/proxy.ts` and `src/platform/proxy/**`.
- `tests/contract/proxy-request-pipeline.contract.test.ts` asserts the
  composition root, the allowed import surface, the matcher matrix, the security
  header set, the request-ID contract, the cookie policy, and the route rules.
- `tests/e2e/proxy.e2e.spec.ts` asserts observable behavior in both locales.
