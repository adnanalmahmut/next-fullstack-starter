# Architecture Documentation

System-level architectural documentation lives here.

## Documents

- [Layer and Module Boundaries](./layer-boundaries.md)
- [Module Map](./module-map.md)
- [Error Handling Contracts](./error-handling.md)
- [Observability Foundation](./observability.md)
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
- Semantic design tokens, reusable presentation primitives, and RTL/LTR UI.

Future documentation may cover:

- System context.
- Authentication and authorization.
- Data ownership.
- Internationalization.
- Caching.
- Background jobs.
- Deployment architecture.

Documentation must describe implemented architecture. Do not document
speculative modules, services, or infrastructure as though they already exist.
