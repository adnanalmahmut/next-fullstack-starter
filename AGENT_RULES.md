# AGENT_RULES.md

## 1. Purpose

Build and maintain a production-grade, multilingual Next.js full-stack
application as a modular monolith.

The architecture must provide:

- Clear feature boundaries.
- Clear layer boundaries.
- Server-side authentication and authorization.
- First-class RTL and LTR support.
- Prisma-based data access.
- Next.js cache and Redis from the first release.
- Enforced import rules through ESLint.
- Mandatory comprehensive tests for every feature.
- A future path for extracting a project CLI after the architecture is
  proven.

Do not introduce Express, NestJS, microservices, or a custom Next.js
server unless an approved ADR documents a concrete requirement.

## 2. Mandatory Stack

Use the following stack unless an approved ADR explicitly changes it:

- Next.js App Router.
- React Server Components by default.
- TypeScript with strict mode.
- PostgreSQL.
- Stable GA Prisma ORM.
- Better Auth.
- Better Auth Admin plugin and custom access control for roles and
  permissions.
- Zod for runtime validation.
- `next-intl` for internationalization.
- Next.js Cache Components and cache tags.
- Redis for shared cache, rate limits, locks, temporary data, and
  queues.
- BullMQ with a dedicated worker when durable background jobs are
  required.
- Tailwind CSS.
- shadcn/ui for reusable application UI primitives.
- Pino-compatible structured logging.
- OpenTelemetry-compatible tracing.
- Sentry or an equivalent error-monitoring provider.
- Vitest for unit and integration tests.
- Playwright for end-to-end tests.
- ESLint for architecture and import-boundary enforcement.
- pnpm as the package manager.

Do not adopt experimental ORM replacements or early-access Prisma
products in production without an ADR.

## 3. Architectural Style

Use a feature-first modular monolith with layered modules.

Each business module contains:

    module/
    ├── domain/
    ├── application/
    ├── infrastructure/
    ├── presentation/
    ├── module.config.ts
    ├── README.md
    ├── index.server.ts
    └── index.client.ts

Layer responsibilities:

    presentation
        ↓
    application
        ↓
    domain

    infrastructure
        ↓
    application ports and domain contracts

Rules:

- `domain` contains pure business rules.
- `application` contains use cases, commands, queries, orchestration,
  and transaction boundaries.
- `infrastructure` contains Prisma repositories, Redis adapters,
  external services, queues, storage, and provider implementations.
- `presentation` contains Server Actions, Route Handler adapters, input
  schemas, presenters, and feature UI.
- `app` contains routing and framework adapters only.
- `platform` contains shared technical infrastructure.
- `shared` contains small stable primitives only.
- Business rules must not live in `app`, React components, Route
  Handlers, Server Actions, Prisma repositories, or Redis adapters.

## 4. Project Structure

Use this structure:

    .
    ├── docs/
    │   ├── architecture/
    │   ├── adr/
    │   ├── threat-model/
    │   └── testing/
    │
    ├── messages/
    │   ├── ar.json
    │   └── en.json
    │
    ├── prisma/
    │   ├── schema/
    │   │   ├── schema.prisma
    │   │   ├── identity.prisma
    │   │   ├── catalog.prisma
    │   │   ├── orders.prisma
    │   │   └── shared.prisma
    │   ├── migrations/
    │   └── seed.ts
    │
    ├── src/
    │   ├── app/
    │   │   ├── [locale]/
    │   │   │   ├── layout.tsx
    │   │   │   ├── (public)/
    │   │   │   ├── (auth)/
    │   │   │   ├── (front-office)/
    │   │   │   └── (admin)/
    │   │   │       └── admin/
    │   │   └── api/
    │   │       ├── v1/
    │   │       ├── auth/
    │   │       ├── webhooks/
    │   │       └── cron/
    │   │
    │   ├── modules/
    │   ├── platform/
    │   │   ├── actions/
    │   │   ├── auth/
    │   │   ├── cache/
    │   │   ├── database/
    │   │   ├── errors/
    │   │   ├── events/
    │   │   ├── http/
    │   │   ├── jobs/
    │   │   ├── observability/
    │   │   ├── proxy/
    │   │   ├── rate-limit/
    │   │   └── storage/
    │   │
    │   ├── shared/
    │   ├── ui/
    │   ├── i18n/
    │   ├── config/
    │   ├── proxy.ts
    │   ├── instrumentation.ts
    │   └── instrumentation-client.ts
    │
    ├── tests/
    │   ├── contract/
    │   ├── integration/
    │   ├── e2e/
    │   └── fixtures/
    │
    └── scripts/

Do not create generic folders such as `utils`, `helpers`, or `services`
without a precise scope.

Prefer names such as:

- `date-formatting`
- `permission-checks`
- `order-pricing`
- `payment-signatures`
- `cache-keys`

## 5. Application Areas

The application must define these route areas:

    (public)
    Public pages available without authentication.

    (auth)
    Guest-only pages such as login and registration.

    (front-office)
    Authenticated customer or member pages.

    (admin)
    Authenticated back-office pages requiring administrative permissions.

    api/v1
    Versioned HTTP API.

    api/auth
    Better Auth handlers.

    api/webhooks
    External provider callbacks with signature verification.

    api/cron
    Protected scheduled task entry points.

Route groups organize layouts. They are not security boundaries.

Every protected page, Server Action, query, command, and Route Handler
must enforce authorization on the server.

## 6. Internationalization and Direction

Internationalization is mandatory from the first feature.

Use:

- `next-intl`.
- A top-level `[locale]` route segment.
- Locale-aware navigation helpers.
- Locale-aware metadata.
- Locale-aware formatting for dates, times, numbers, percentages, and
  currencies.

Default supported locales:

    export const locales = ['ar', 'en'] as const;
    export const defaultLocale = 'ar';

Direction mapping:

    export const localeDirection = {
      ar: 'rtl',
      en: 'ltr',
    } as const;

The locale root layout must set both attributes:

    <html lang={locale} dir={localeDirection[locale]}>

Rules:

- Never hardcode user-facing text in components, pages, actions, errors,
  emails, notifications, or validation output.
- Translation keys must be stable and feature-scoped.
- Use logical CSS properties such as `margin-inline-start`,
  `padding-inline-end`, `inset-inline-start`, and logical Tailwind
  utilities.
- Do not use physical left/right positioning unless the design is
  intentionally direction-independent.
- Icons that represent direction must mirror in RTL.
- Logos, media controls, charts, numbers, and code snippets must not be
  mirrored automatically.
- Forms must be tested in both RTL and LTR.
- Truncation, tables, menus, dialogs, toasts, breadcrumbs, pagination,
  and sidebars must be verified in both directions.
- API response codes must remain language-neutral.
- Translate messages at the presentation boundary, not inside the domain
  layer.
- Store timestamps in UTC.
- Format timestamps using the active locale and explicit application
  time-zone policy.
- Do not store translated database content as JSON unless the feature
  explicitly requires field-level localization.
- For localized business content, choose and document one strategy:
  - Translation table per entity.
  - Locale-specific document.
  - Locale-independent source plus translated variants.
- Public localized pages must provide canonical and alternate-language
  metadata where applicable.

## 7. Module Boundaries

Each module owns:

- Its business rules.
- Its Prisma models.
- Its use cases.
- Its permissions.
- Its cache keys and tags.
- Its events.
- Its public server API.
- Its client-safe exports.
- Its tests.
- Its architecture documentation.

Each `module.config.ts` must declare:

    export const moduleConfig = {
      name: 'catalog',
      ownsModels: ['Product', 'Category'],
      permissions: [
        'catalog.product.read',
        'catalog.product.create',
        'catalog.product.update',
        'catalog.product.delete',
      ],
      publishesEvents: ['catalog.product-created'],
      consumesEvents: [],
    } as const;

Cross-module rules:

- Import another module only through `index.server.ts` or
  `index.client.ts`.
- Never import another module’s `infrastructure`, repository, Prisma
  model adapter, or internal file.
- Do not update another module’s owned models directly.
- Use a public use case or integration event.
- Circular module dependencies are forbidden.
- A shared abstraction may move to `shared` only after at least two real
  modules require the same stable concept.
- Do not create speculative abstractions.

## 8. Import Rules

ESLint must enforce architecture boundaries.

### Domain

May import:

- Its own domain files.
- Stable primitives from `shared`.

Must not import:

- `next/*`
- React
- Prisma
- Redis
- Better Auth
- HTTP types
- Environment variables
- Infrastructure
- Presentation

### Application

May import:

- Its own domain.
- Application ports.
- Stable primitives from `shared`.

Must not import:

- React components.
- `NextRequest`, `NextResponse`, `cookies`, `headers`, or `redirect`.
- Prisma Client directly.
- Redis clients directly.
- UI code.
- Another module’s internal files.

### Infrastructure

May import:

- Prisma.
- Redis.
- External SDKs.
- Domain contracts.
- Application ports.

Must not contain:

- Page routing.
- React UI.
- User-facing translations.
- Business decisions that belong to domain or application.

### Presentation

May import:

- Module application use cases.
- Module presenters.
- Platform action and HTTP factories.
- Translation APIs.
- UI components.

Must not:

- Query Prisma directly.
- Access Redis directly.
- Contain transaction orchestration.
- Implement core business rules.

### Client Components

Must not import:

- Prisma.
- Better Auth server instance.
- Redis.
- Node-only packages.
- `server-only` modules.
- Server module entry points.
- Secrets or environment variables without `NEXT_PUBLIC_`.

Use `server-only` in server entry points and infrastructure modules.

Use public module entry points only at module boundaries.

Avoid broad barrel files. `index.server.ts` and `index.client.ts` exist
only as controlled module boundaries.

## 9. Prisma Rules

Use stable Prisma ORM with PostgreSQL.

Rules:

- Use a single Prisma Client instance.
- Create the client in `src/platform/database/prisma.ts`.
- Do not instantiate Prisma Client inside modules, requests, jobs,
  tests, or components.
- Prisma access is server-only.
- Route Handlers, Server Actions, pages, and React components must not
  call Prisma directly.
- Repositories and specialized read models are the only normal Prisma
  access points.
- Use Prisma multi-file schema grouped by business module.
- Every Prisma model must have one owning module.
- Use explicit database constraints:
  - Primary keys.
  - Foreign keys.
  - Unique constraints.
  - Required fields.
  - Check constraints where supported and appropriate.
- Use explicit join models when relationships contain business metadata.
- Avoid implicit behavior for financial, audited, or stateful
  relationships.
- Select only required fields.
- Do not return raw Prisma records to Client Components or public APIs.
- Map database records to domain entities or DTOs.
- Use cursor pagination for large or frequently changing collections.
- Add indexes based on real query patterns.
- Do not add indexes without documenting the query they support.
- Use raw SQL only when Prisma cannot express an efficient query.
- Raw SQL must be parameterized, isolated, documented, and
  integration-tested.
- Use application-level transaction boundaries.
- All related state changes and outbox writes must share the same
  transaction.
- Do not call slow external APIs while holding a database transaction.
- Production schema changes require Prisma migrations.
- `db push` is forbidden in production and shared environments.
- Migration files must be reviewed before merge.
- Destructive migrations require an ADR and a rollout plan.

## 10. Authentication and Authorization

Better Auth is the source of truth for:

- Authentication.
- Sessions.
- User lifecycle.
- Roles.
- Permission definitions.
- Permission assignment.
- Administrative user operations.

Use the Better Auth Admin plugin with custom access control.

Permission naming:

    <module>.<resource>.<action>

Examples:

    catalog.product.read
    catalog.product.create
    orders.order.read
    orders.order.refund
    identity.user.manage

Rules:

- Do not authorize through role-name comparisons spread across the
  codebase.
- Convert Better Auth session data into a normalized server-side
  `Actor`.
- Use centralized functions:
  - `getCurrentActor`
  - `requireActor`
  - `requirePermission`
  - `requireAnyPermission`
  - `requireAllPermissions`
- Better Auth permissions handle capability-level access.
- Application policies handle resource-level decisions such as
  ownership, organization membership, record state, and tenant
  boundaries.
- Every authorization decision must be enforced server-side.
- Hiding a button is not authorization.
- Layout redirects are not authorization.
- Proxy redirects are not authorization.
- Route Handlers and Server Actions are public entry points and must
  authenticate independently.
- Administrative actions must create audit records.
- Impersonation must be explicitly enabled, logged, visible in the UI,
  and restricted by permission.
- Session, permission, and role changes must invalidate relevant Redis
  cache entries.
- Never store authorization decisions permanently in the browser.
- Never trust role or permission values supplied by the client.

## 11. Proxy Rules

For Next.js 16 and later, use `src/proxy.ts`.

Proxy is limited to:

- Locale negotiation.
- Locale redirects.
- Request IDs.
- Security headers.
- Lightweight cookie inspection.
- Optimistic redirects for guest, authenticated, and admin areas.
- Rewrites when required.

Proxy must not:

- Query Prisma.
- Perform slow Redis operations.
- Load a complete permission graph.
- Execute business logic.
- Validate JSON request bodies.
- Replace server-side authentication or authorization.
- Become a generic Express-style middleware layer.

Split proxy logic into reusable steps:

    src/platform/proxy/
    ├── compose.ts
    ├── context.ts
    ├── route-classifier.ts
    ├── route-rules.ts
    └── steps/
        ├── locale.step.ts
        ├── request-id.step.ts
        ├── security-headers.step.ts
        ├── session-hint.step.ts
        ├── guest-area.step.ts
        ├── authenticated-area.step.ts
        └── admin-area.step.ts

The root `proxy.ts` must remain a small composition file.

## 12. Validation Rules

Use Zod at every untrusted boundary.

Validate:

- Server Action input.
- Route Handler JSON.
- Query parameters.
- Route parameters.
- FormData.
- Headers used by the application.
- Webhook payloads.
- Environment variables.
- Queue job payloads.
- Data read from Redis.
- External API responses where correctness matters.

Rules:

- Client validation improves UX only.
- Server validation is mandatory.
- Database constraints are mandatory for data integrity.
- Reuse schemas when the transport shape is identical.
- Do not force one schema across different use cases with different
  rules.
- Reject unknown or excessive input when appropriate.
- Define payload-size limits.
- File uploads require MIME, extension, size, and content checks
  appropriate to the risk.
- Domain invariants must still be enforced in the domain layer even
  after Zod validation.

## 13. Server Actions

Server Actions are presentation adapters.

Every action must declare:

- Input schema.
- Authentication requirement.
- Permission requirement.
- Application use case.
- Error mapping.
- Cache invalidation.
- Audit behavior when applicable.

Use a centralized `defineAction` factory.

A Server Action must not:

- Contain Prisma queries.
- Contain business logic.
- Trust hidden fields or client-supplied IDs.
- Return internal errors.
- Return raw Prisma objects.
- Depend on the page having already checked authorization.

Return a typed action result:

    type ActionResult<T> =
      | { ok: true; data: T }
      | {
          ok: false;
          error: {
            code: string;
            message?: string;
            fields?: Record<string, string[]>;
          };
        };

Error codes remain language-neutral. Translate them in the presentation
layer.

## 14. Route Handlers

Route Handlers are HTTP adapters.

Use a centralized `defineRoute` factory that supports:

- HTTP method.
- Authentication.
- Permission checks.
- Params schema.
- Query schema.
- Body schema.
- Rate limiting.
- Idempotency where required.
- Handler execution.
- Error mapping.
- Structured logging.
- Response serialization.
- Audit logging.

A route file should only bind exported handlers:

    export const GET = listProductsRoute;
    export const POST = createProductRoute;

Rules:

- Version public APIs under `/api/v1`.
- Keep API errors machine-readable.
- Use consistent response envelopes.
- Verify webhook signatures before parsing trusted business data.
- Webhook processing must be idempotent.
- Do not execute long-running work inside HTTP requests.
- Enqueue durable work and return an appropriate response.
- Apply rate limits to authentication, public forms, sensitive reads,
  and mutations.

## 15. Data Transfer and Presentation

Use explicit DTOs and presenters.

Rules:

- Do not expose database records directly.
- Do not expose internal IDs, secrets, audit fields, or authorization
  fields unless required.
- Return the minimum fields required by the consumer.
- Convert decimals, dates, enums, and value objects explicitly.
- Keep domain entities independent from React and HTTP.
- Translate labels in the UI, not inside DTOs.
- Public API payloads must remain stable and language-neutral unless
  localized content is explicitly requested.

## 16. Caching

Caching is included from the first release.

Use two cache layers with distinct responsibilities.

### Next.js Cache

Use for:

- Server-rendered read data.
- Public catalogs.
- Public content.
- Stable configuration.
- Expensive read models.
- Page and component revalidation.

Use explicit cache tags and cache-life policies.

### Redis

Use for:

- Shared mutable cache.
- Permission and session-derived cache.
- Rate limits.
- Idempotency records.
- Distributed locks.
- Temporary tokens.
- Queue storage.
- Cross-instance coordination.

Rules:

- Every cached query must define:
  - Key.
  - Scope.
  - TTL.
  - Invalidation trigger.
  - Whether stale data is allowed.
- Cache keys must be created by module-owned key factories.
- Include locale, tenant, actor, filters, and version in keys when they
  change the result.
- Never cache sensitive user data under a shared key.
- Never cache authorization-filtered results without actor or tenant
  scope.
- Use cache-aside unless a documented pattern requires otherwise.
- Mutation flow:
  1.  Validate.
  2.  Authorize.
  3.  Commit the database transaction.
  4.  Invalidate Redis keys.
  5.  Invalidate or update Next.js cache tags.
  6.  Publish post-commit events.
- Do not invalidate cache before a successful commit.
- Cache invalidation must be tested.
- Cache failures must not corrupt the source of truth.
- PostgreSQL remains the source of truth.
- Prefix Redis keys by application, environment, module, and version.
- Queue and cache keys must use separate prefixes.
- Do not use Redis as the primary durable database.

## 17. Background Jobs and Events

Use BullMQ with a dedicated worker when work must survive request
completion.

Use jobs for:

- Email delivery.
- Notifications.
- Reports.
- Media processing.
- Imports and exports.
- Webhook retries.
- External synchronization.
- Outbox processing.

Rules:

- Do not run durable background work using an untracked promise.
- Every job payload must be Zod-validated.
- Every job must define:
  - Name.
  - Version.
  - Retry count.
  - Backoff.
  - Timeout.
  - Idempotency behavior.
  - Logging context.
  - Failure handling.
- Jobs must be safe to retry.
- Use an outbox pattern for events that must not be lost after a
  database commit.
- Workers must not depend on React or Next.js routing.
- Keep workers in the same repository until an ADR justifies separation.

## 18. Error Handling

Use typed application errors.

Required categories:

- Validation.
- Unauthenticated.
- Forbidden.
- Not found.
- Conflict.
- Rate limited.
- External dependency failure.
- Unexpected internal failure.

Rules:

- Domain and application layers throw typed errors.
- HTTP and action adapters map errors to transport-specific responses.
- Do not leak stack traces, SQL errors, Prisma internals, Redis details,
  or provider secrets.
- Log unexpected errors with request and actor context.
- Expected validation and authorization failures must not be logged as
  server crashes.
- Error codes are stable and language-neutral.
- User-facing messages are localized at the presentation boundary.

## 19. Observability and Audit

Every request and job must have structured context.

Required fields where available:

    requestId
    jobId
    userId
    actorType
    organizationId
    module
    operation
    route
    locale
    durationMs
    status
    errorCode

Rules:

- Initialize tracing and monitoring in `instrumentation.ts`.
- Use structured logs only.
- Do not use uncontrolled `console.log` in production code.
- Never log passwords, tokens, cookies, authorization headers, payment
  secrets, or sensitive personal data.
- Administrative, financial, permission, impersonation, and destructive
  operations require audit records.
- Audit records must include actor, action, resource, target, result,
  timestamp, and request ID.
- Audit logs are append-only from the application perspective.

## 20. React and Next.js Rules

Default to Server Components.

Use Client Components only for:

- Browser APIs.
- Local interactive state.
- Event handlers.
- Client-only third-party libraries.
- Real-time client subscriptions.

Rules:

- Keep `"use client"` as low in the tree as possible.
- Do not fetch server-owned data in a Client Component when a Server
  Component can provide it.
- Do not call the application’s own Route Handler from a Server
  Component.
- Call the application query directly.
- Start independent promises early and await them together.
- Avoid sequential data-fetching waterfalls.
- Use Suspense boundaries for independent slow sections.
- Minimize data serialized from server to client.
- Import components directly.
- Avoid broad UI barrel exports.
- Dynamically import heavy client-only components.
- Do not define components inside components.
- Use stable keys.
- Keep side effects out of render.
- Do not mirror all server state into client state.
- Use optimistic UI only when rollback and error states are defined.

## 21. UI and Accessibility

Rules:

- Reusable UI primitives belong in `src/ui`.
- Feature-specific UI belongs in the feature’s
  `presentation/components`.
- Do not place business rules inside reusable UI primitives.
- All interactive controls require accessible names.
- Keyboard navigation is mandatory.
- Focus management is mandatory for dialogs, menus, and route
  transitions where applicable.
- Color must not be the only state indicator.
- Forms must associate errors with fields.
- Loading, empty, error, and permission-denied states are mandatory.
- Every layout must be tested in Arabic RTL and English LTR.
- Responsive behavior must be verified at mobile, tablet, and desktop
  breakpoints.

## 22. Testing Policy

A feature is not complete and must not be merged unless its required
tests exist and pass.

Every feature must test the behavior it introduces.

### Domain Unit Tests

Required for:

- Business invariants.
- Value objects.
- State transitions.
- Policies.
- Calculations.
- Edge cases.

### Application Tests

Required for:

- Commands.
- Queries.
- Permission orchestration.
- Transaction behavior.
- Failure behavior.
- Event publication.
- Cache invalidation decisions.

### Infrastructure Integration Tests

Required for:

- Prisma repositories.
- Database constraints.
- Transactions and rollbacks.
- Redis adapters.
- Cache key behavior.
- External provider adapters using controlled fakes or test
  environments.

Use a real PostgreSQL test database for repository integration tests.

### Contract Tests

Required for:

- Route Handler status codes.
- Request validation.
- Authentication.
- Authorization.
- Response schemas.
- Error schemas.
- Idempotency where applicable.
- Webhook signature and replay behavior.

### End-to-End Tests

Required for critical user journeys:

- Authentication.
- Registration where enabled.
- Permission-restricted navigation.
- Main business workflow.
- Administrative workflow.
- Payment or other critical external workflow using a safe test
  provider.
- Locale switching.
- Arabic RTL rendering.
- English LTR rendering.

Every protected feature must include:

- Authenticated success.
- Unauthenticated rejection.
- Missing-permission rejection.
- Resource-policy rejection where applicable.

Every mutation must include:

- Valid input.
- Invalid input.
- Not-found or conflict behavior.
- Database failure or rollback behavior when relevant.
- Cache invalidation behavior.
- Audit behavior when required.

Coverage thresholds:

    Overall statements: 85%
    Overall branches: 80%
    Domain statements: 95%
    Application statements: 90%

Coverage does not replace behavioral assertions.

Do not:

- Merge skipped tests without an issue reference.
- Use snapshots as the primary proof of business behavior.
- Mock Prisma repositories in repository integration tests.
- Test implementation details instead of observable behavior.
- Reduce coverage thresholds to pass CI.

## 23. Feature Acceptance Gate

A feature is accepted only when all applicable items are complete:

- Module boundary is defined.
- `module.config.ts` is updated.
- Prisma ownership is declared.
- Permissions are defined in Better Auth access control.
- Resource policies are implemented.
- Input schemas are implemented.
- Server-side authorization is implemented.
- Arabic and English translations are complete.
- RTL and LTR layouts are verified.
- Cache keys, TTLs, and invalidation are defined.
- Audit behavior is defined.
- Unit tests pass.
- Application tests pass.
- Integration tests pass.
- Contract tests pass.
- Required E2E tests pass.
- ESLint boundaries pass.
- Type checking passes.
- Prisma validation passes.
- Database migrations are reviewed.
- No critical accessibility issue remains.
- No unhandled loading, empty, error, or forbidden state remains.
- Architecture documentation is updated when behavior or boundaries
  changed.

A feature without tests is incomplete.

A feature with failing architecture rules is incomplete.

A feature with untranslated user-facing text is incomplete.

## 24. Required CI Checks

CI must run at minimum:

    pnpm install --frozen-lockfile
    pnpm lint
    pnpm typecheck
    pnpm prisma:validate
    pnpm prisma:format:check
    pnpm test:unit
    pnpm test:integration
    pnpm test:contract
    pnpm test:e2e
    pnpm test:coverage
    pnpm build

CI must fail on:

- ESLint warnings configured as errors.
- Type errors.
- Import-boundary violations.
- Circular dependencies.
- Invalid Prisma schema.
- Unreviewed migration drift.
- Missing translations.
- Failing tests.
- Coverage regression below thresholds.
- Build failure.

## 25. Security Rules

Rules:

- Treat every server entry point as public.
- Validate all untrusted input.
- Authorize every protected operation.
- Check object ownership and tenant boundaries.
- Use secure, HTTP-only, same-site cookies as appropriate.
- Apply CSRF protections according to the authentication flow.
- Rate-limit sensitive endpoints.
- Verify webhook signatures.
- Use idempotency keys for payment and retry-prone mutations.
- Store secrets only in server environment variables or a secret
  manager.
- Validate environment variables at startup.
- Do not expose secrets through `NEXT_PUBLIC_`.
- Do not trust client-supplied prices, roles, permissions, ownership, or
  calculated totals.
- Perform financial calculations on the server.
- Use integer minor units or an approved decimal strategy for money.
- Audit sensitive changes.
- Apply least privilege to database and Redis credentials.
- Run dependency and secret scanning in CI.

## 26. Documentation and ADRs

Maintain:

    docs/architecture/system-context.md
    docs/architecture/module-map.md
    docs/architecture/layer-boundaries.md
    docs/architecture/data-ownership.md
    docs/architecture/authentication.md
    docs/architecture/authorization.md
    docs/architecture/i18n.md
    docs/architecture/caching.md
    docs/architecture/jobs.md
    docs/architecture/testing.md

Create an ADR before:

- Adding a new framework.
- Adding a new persistence technology.
- Adding a second API framework.
- Introducing microservices.
- Moving a module into a separate deployment.
- Changing the authentication provider.
- Changing the permission model.
- Bypassing repository boundaries.
- Adding a custom Next.js server.
- Adopting an experimental database or ORM feature.
- Introducing a new cross-module shared abstraction.

ADRs must describe:

- Context.
- Decision.
- Alternatives.
- Consequences.
- Migration or rollback plan.

## 27. CLI Policy

Do not build the project CLI during the initial architecture phase.

During the initial phase:

- Keep code templates small and explicit.
- Record repeated setup steps.
- Stabilize at least three real modules.
- Identify patterns that are genuinely repeated.
- Avoid designing generator APIs before the generated structure is
  proven.

A CLI may be started later only when:

- The architecture has remained stable across at least three modules.
- Route and action factories are stable.
- Module metadata is stable.
- Test templates are stable.
- ESLint boundaries are stable.
- Repeated manual work is measurable.

The future CLI may generate code, but it must not hide architecture or
generate untested business behavior.

## 28. Agent Operating Rules

Before changing code:

1.  Read this file.
2.  Read the target module’s `README.md`.
3.  Read its `module.config.ts`.
4.  Identify the owning module.
5.  Identify affected permissions.
6.  Identify affected cache keys and tags.
7.  Identify required translations.
8.  Identify required tests.
9.  Check whether an ADR is required.

While changing code:

- Make the smallest coherent change.
- Preserve module boundaries.
- Keep framework adapters thin.
- Add tests with the implementation.
- Update Arabic and English translations together.
- Update cache invalidation with mutations.
- Do not weaken security or tests to complete a task.
- Do not add dependencies when the existing stack is sufficient.
- Do not create speculative abstractions.
- Do not move code to `shared` merely to avoid a dependency decision.
- Do not bypass lint rules with disables unless the reason is documented
  and narrowly scoped.
- Do not use `any` unless isolated at an external boundary and
  justified.
- Do not suppress TypeScript errors.
- Do not modify generated Prisma files.
- Do not modify migration history after it has been applied to a shared
  environment.

Before completing a change:

1.  Run lint.
2.  Run type checking.
3.  Validate Prisma.
4.  Run affected unit tests.
5.  Run affected integration tests.
6.  Run affected contract tests.
7.  Run required E2E tests.
8.  Run the production build.
9.  Verify Arabic RTL.
10. Verify English LTR.
11. Confirm cache invalidation.
12. Confirm authorization.
13. Confirm audit behavior.
14. Update documentation.

If a required check cannot be completed, report it explicitly. Do not
claim the feature is complete.
