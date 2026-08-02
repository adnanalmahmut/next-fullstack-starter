# Architecture Documentation

System-level architectural documentation lives here.

## Documents

- [Layer and Module Boundaries](./layer-boundaries.md)
- [Module Map](./module-map.md)
- [Error Handling Contracts](./error-handling.md)
- [Observability Foundation](./observability.md)
- [Proxy Request Pipeline](./proxy-request-pipeline.md)
- [Authentication Foundation](./authentication-foundation.md)
- [Authorization and Admin Access Control](./authorization-admin-access-control.md)
- [Server Action Factory](./server-action-factory.md)
- [Route Handler Factory](./route-handler-factory.md)
- [Redis Foundation](./redis-foundation.md)
- [Cache and Concurrency Controls](./cache-and-concurrency-controls.md)
- [Background Jobs and Transactional Outbox](./background-jobs-and-outbox.md)
- [Application Audit Platform](./application-audit-platform.md)
- [Object Storage and Uploads](./object-storage-and-uploads.md)
- [Design System](../design-system/README.md)
- [Module Development Guide](../../src/modules/README.md)
- [Repository Rules](../../AGENT_RULES.md)

## Scope

This directory records architectural decisions and constraints that apply
across the repository.

Current documentation covers:

- Source-code areas.
- Business module structure.
- Layer responsibilities.
- Cross-module dependency boundaries.
- Client-safe and server-only boundaries.
- Automated architecture enforcement.
- Module ownership and public entry points.
- Typed internal errors and safe transport contracts.
- Request correlation, request-scoped context, and structured logging.
- Locale negotiation, request correlation, baseline security headers, and route
  classification in the proxy request pipeline.
- Email and password authentication, database-backed sessions, and server-side
  session validation.
- Capability permissions, a normalized actor, resource policies, the
  least-privilege administrator role, and the protected administration area.
- The single Server Action adapter: declared authorization modes, a fixed
  execution order, inferred input and output types, lifecycle hooks, allowlisted
  logging, and declarative post-success cache invalidation.
- The single Route Handler adapter: the versioned `/api/v1` surface, declared
  authorization modes, a fixed execution order, independently validated params,
  query, and body, typed lifecycle hooks, one JSON response envelope, and
  allowlisted request logging.
- An optional Redis foundation: disabled by default, lazily connected, health
  contract, key namespaces, isolated test suite, and a removal procedure that
  touches no business code.
- Cache and concurrency controls: Next.js Cache Components with a closed set of
  cache-life profiles, module-owned cache identities, Redis cache-aside, one
  invalidation system shared by Actions and Route Handlers, an atomic
  fixed-window rate limiter, an idempotency lifecycle, lease locks, and an
  explicit fallback for every one of them.
- An optional background-jobs platform: a transactional outbox in PostgreSQL, a
  separate BullMQ worker process, a versioned job registry, bounded retries and
  timeouts, idempotent database execution, two dead-letter stores, and a removal
  procedure that touches no business code.
- A generic application audit platform: module-owned action definitions, a
  generic actor and result contract, a closed metadata policy, a transactional
  and a post-commit writer, append-only storage, bounded keyset paging, and one
  admin reader that renders any module's actions.
- An optional object storage platform: an S3-compatible adapter for AWS S3,
  Cloudflare R2, and MinIO, durable upload intents, presigned direct uploads
  that never route bytes through Next.js, checksum and metadata verification,
  an immutable staging-to-final promotion, private short-lived downloads, a
  content-inspection extension point, a bounded unscheduled cleanup contract,
  and a removal procedure that touches no business code.
- Semantic design tokens, reusable presentation primitives, and RTL/LTR UI.

Future documentation may cover:

- System context.
- Data ownership.
- Internationalization.
- Scheduled and recurring jobs.
- Deployment architecture.

Documentation must describe implemented architecture. Do not document
speculative modules, services, or infrastructure as though they already exist.
