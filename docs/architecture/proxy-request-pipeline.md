# Proxy Request Pipeline

This document defines the implemented request pipeline that runs in front of the
application. Its goals are predictable locale negotiation, a correlation ID that
reaches server handling, a small baseline of response security headers, and an
explicit route classification that future features can extend.

It does not implement authentication, authorization, session handling, rate
limiting, business logic, request-body validation, or any database or cache
access.

## Why the proxy is not an authorization boundary

Proxy code runs before routes are rendered and can be deployed to a network edge
ahead of the application runtime. It sees a URL, headers, and cookies — not
verified identity. Next.js also treats Server Functions as POST requests to the
route that uses them, so a matcher change or a moved Server Function can silently
remove proxy coverage.

Therefore the proxy may only make optimistic routing decisions. Every protected
page, Route Handler, Server Action, and application use case must authenticate
and authorize independently on the server. A proxy redirect is a user-experience
shortcut, never an access-control decision.

## Location and dependency boundary

The composition root stays at `src/proxy.ts`. It contains no logic: it imports
the pipeline, exports the proxy function, and declares a statically analyzable
`config.matcher`.

The pipeline lives in `src/platform/proxy`:

| Area                             | Responsibility                                 |
| -------------------------------- | ---------------------------------------------- |
| `compose.ts`                     | Runs the steps in a fixed order                |
| `context.ts`                     | Builds the per-request data a step may read    |
| `route-classifier.ts`            | Pure pathname-to-area classification           |
| `route-rules.ts`                 | Immutable route area declarations              |
| `steps/request-id.step.ts`       | Correlation ID forwarding and return           |
| `steps/locale.step.ts`           | `next-intl` negotiation and locale cookie sync |
| `steps/security-headers.step.ts` | Baseline response security headers             |

The pipeline may import `next/server`, `next-intl/middleware`, the locale
configuration in `src/i18n`, and the request-ID contract in
`src/platform/observability`. It must not import Prisma, generated Prisma
source, the database platform, a cache or Redis client, a queue client, Better
Auth, React, UI code, or any business module. ESLint enforces the import
restrictions and a contract test asserts the allowed import surface.

## Pipeline order

```text
1. request-id step    resolve or generate the ID, write it on the request headers
2. context            classify the route area
3. locale step        run next-intl for pages, skip it for API routes
4. security headers   apply the baseline set to the response
5. request-id step    return the same ID on the response
```

Steps 4 and 5 mutate the response produced by step 3. Nothing rebuilds a
response from an existing body, so status, `Location`, rewrite metadata, the
`next-intl` locale header, `Set-Cookie` values, the alternate-links `Link`
header, and streaming behavior are all preserved.

## Locale step

The locale contract is unchanged:

```text
locales:        ar, en
default locale: ar
locale prefix:  always
detection:      false
locale cookie:  APP_LOCALE
```

`next-intl` owns redirects, rewrites, and the resolved locale. Its response is
returned as-is. After it runs, the step writes `APP_LOCALE` only when the
incoming cookie does not already match the locale resolved from the URL, so an
unchanged cookie is never rewritten.

`next-intl` performs its own conditional cookie sync, which skips background
router requests and skips writing when an absent cookie already agrees with
`Accept-Language`. The pipeline's write runs afterwards and is the authoritative
one, which keeps the cookie deterministic for the URL that was requested.

API routes are not internationalized. For an `api` area the step returns
`NextResponse.next({ request: { headers } })` instead, which skips locale
negotiation entirely while still forwarding the request headers upstream.

An unmatched page pathname stays classified as `unknown` but is still
internationalized, preserving the existing behavior where `/reports` redirects
to `/ar/reports` and then renders the not-found page.

## Request ID step

The header, validation rule, and generation strategy come from
`src/platform/observability/request-id.server`. The pipeline defines no
competing header name and no second UUID validator.

1. A client-supplied `x-request-id` is reused only when it satisfies the bounded
   UUID v4 contract.
2. A missing, empty, malformed, oversized, or non-version-4 value is replaced.
3. The resolved value is written on the incoming request headers **before** the
   locale step runs. `next-intl` copies the request headers into its
   `NextResponse.next({ request })` or `NextResponse.rewrite(url, { request })`
   result, which is how Next.js forwards headers to server handling.
4. The same value is written on the outgoing response.

Upstream propagation is proven behaviorally rather than assumed. The
development-and-test-only Route Handler at
`/api/diagnostics/request-context` reads `x-request-id` through `headers()` and
reports it, and an end-to-end test asserts that the reported value equals the
response header for a generated, a valid incoming, and an invalid incoming ID.
The route returns `404` in staging and production and carries no business
behavior.

Request headers are forwarded with `NextResponse.next({ request: { headers } })`,
never `NextResponse.next({ headers })`, which would expose them to the client.
Next.js encodes the upstream override as internal `x-middleware-request-*`
response headers and strips them before the client sees the response; an
end-to-end test asserts that no such header and no forwarded `Authorization`
value reaches the client.

A request ID is a correlation identifier only. It is not identity,
authentication, authorization, or proof of origin.

## Security headers

Every proxied response receives exactly:

```text
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

They are applied in one place, on the final response, for pages, redirects,
rewrites, and API responses. No value derives from user input.

The following are deliberately absent because each needs its own documented
policy decision and can break OAuth flows, uploads, embedding, or deployment:

```text
Content-Security-Policy
Content-Security-Policy-Report-Only
Strict-Transport-Security
CORS policy
Cross-Origin-Opener-Policy
Cross-Origin-Resource-Policy
Cross-Origin-Embedder-Policy
X-XSS-Protection
nonces
```

## Route classification

```ts
type RouteArea =
  "public" | "auth" | "front-office" | "admin" | "api" | "unknown";
```

`classifyRoute` is pure. It never reads a session, produces a response, decides
authorization, or imports a framework API. Rules and the locale list are passed
in, so the algorithm is testable independently of production routing.

Classification rules:

- Comparison is segment-based, so `/admin` never matches `/administrator` and a
  trailing slash or a repeated separator changes nothing.
- A query string is never part of classification; the classifier receives a
  pathname only.
- A localized rule is compared after the locale prefix is removed, so `/ar/...`
  and `/en/...` classify identically.
- A non-localized rule is compared against the raw pathname, because API routes
  carry no locale prefix.
- An `exact` rule matches only its own pathname; a `subtree` rule also matches
  descendants.
- The first matching rule wins.
- An unmatched pathname is `unknown`. Unknown is never treated as public.

Route groups such as `(public)`, `(auth)`, `(admin)`, and `(development)` do not
appear in a URL, so runtime classification never depends on them.

### Declared rules

Only routes that exist in `src/app` are declared:

| Rule             | Area     | Match     | Localized |
| ---------------- | -------- | --------- | --------- |
| `/api`           | `api`    | `subtree` | no        |
| `/`              | `public` | `exact`   | yes       |
| `/design-system` | `public` | `exact`   | yes       |

`auth`, `front-office`, and `admin` are part of the type and are exercised by
classifier fixtures, but they have no production rule because no such route
exists yet. Each will gain its rule in the pull request that adds the route. A
contract test asserts both directions: every routable pathname in `src/app`
classifies to a declared area, and every declared rule is matched by a real
route.

## Matcher matrix

```ts
matcher: ["/((?!_next|_vercel|.*\\..*).*)", "/api/:path*"];
```

| Request shape                                                    | Proxied | Locale step  | Request ID | Security headers |
| ---------------------------------------------------------------- | ------- | ------------ | ---------- | ---------------- |
| `/`, `/ar`, `/en`                                                | yes     | yes          | yes        | yes              |
| `/ar/design-system`                                              | yes     | yes          | yes        | yes              |
| Unmatched page pathname                                          | yes     | yes          | yes        | yes              |
| `/api/...`, including dotted paths                               | yes     | no           | yes        | yes              |
| Server Function POST on a proxied route                          | yes     | as the route | yes        | yes              |
| `/_next/static/...`                                              | no      | no           | no         | no               |
| `/_next/image`                                                   | no      | no           | no         | no               |
| `/_vercel/...`                                                   | no      | no           | no         | no               |
| `favicon.ico`, `robots.txt`, `sitemap.xml`, any dotted page path | no      | no           | no         | no               |

The second matcher entry exists because API coverage must not depend on the
"no file extension" heuristic used for pages: an API path such as
`/api/v1/report.pdf` still needs the correlation ID and the baseline headers.
API routes skip locale handling through route classification, not through the
matcher, which keeps one pipeline for every proxied request.

Next.js documents that `_next/data` requests still invoke the proxy even when a
negative matcher excludes them. That is intentional upstream behavior and is
safe here, because the pipeline makes no access-control decision.

The matcher is asserted two ways: a contract test evaluates the real matcher
against a path matrix using `unstable_doesMiddlewareMatch`, and end-to-end tests
confirm that excluded paths carry no `x-request-id` and no security header,
which proves the proxy did not run.

Static assets are deliberately excluded so the proxy does not intercept them.
Response headers for static assets remain the responsibility of the hosting
layer.

## Cookie policy

The pipeline reads exactly one cookie: `APP_LOCALE`, through
`i18nConfig.localeCookie`. It writes exactly that cookie and no other.

It does not read, guess, parse, or validate a session cookie, and it does not
know a session cookie name. Better Auth is not integrated yet, so there is no
stable session contract to read.

## Context

```text
request
pathname
area
requestId
```

The context deliberately excludes an actor, a session, permissions, a database
client, a cache client, and any service container. It must not become a service
locator.

## What must still be checked elsewhere

| Boundary              | Responsibility                                                  |
| --------------------- | --------------------------------------------------------------- |
| Pages                 | Authenticate and authorize before rendering protected content   |
| Route Handlers        | Authenticate, authorize, validate input, and rate-limit         |
| Server Actions        | Authenticate, authorize, and validate input on every invocation |
| Application use cases | Enforce resource policies, ownership, and tenant boundaries     |

Hiding a control is not authorization. A layout redirect is not authorization. A
proxy redirect is not authorization.

## Deferred

The following are intentionally not implemented in this foundation:

- Session hint reading, which requires a stable Better Auth session cookie.
- Optimistic guest, authenticated, and admin redirects, which depend on that
  hint and will still not be authorization.
- Content Security Policy and nonce generation.
- Strict Transport Security.
- CORS policy.
- Cross-origin isolation headers.
- Rate limiting.
- Request-scoped `AsyncLocalStorage` initialization around all Next.js work,
  which composition boundaries must do explicitly.

## Commands

```bash
pnpm exec vitest run --project unit src/platform/proxy
pnpm exec vitest run --project contract tests/contract/proxy-request-pipeline.contract.test.ts
pnpm exec playwright test tests/e2e/proxy.e2e.spec.ts
pnpm verify
```

## Related documentation

- [Observability Foundation](./observability.md)
- [Layer and Module Boundaries](./layer-boundaries.md)
- [Module Map](./module-map.md)
- [Proxy pipeline implementation notes](../../src/platform/proxy/README.md)
- [Internationalization](../../src/i18n/README.md)
- [Repository Rules](../../AGENT_RULES.md)
