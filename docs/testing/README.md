# Testing

The project uses Vitest for unit, integration, and contract tests, and
Playwright for end-to-end tests.

## Test suites

### Unit tests

Unit tests cover isolated domain, application, and utility behavior.

**Naming:**

```text
src/**/*.unit.test.ts
src/**/*.unit.test.tsx
tests/*.unit.test.ts
tests/*.unit.test.tsx
```

**Run:**

```bash
pnpm test:unit
```

### Integration tests

Integration tests verify interactions between application components and
infrastructure adapters.

**Naming:**

```text
tests/integration/**/*.integration.test.ts
tests/integration/**/*.integration.test.tsx
```

**Run:**

```bash
pnpm test:integration
```

### Contract tests

Contract tests verify stable interfaces such as API payloads, external service
contracts, and module boundaries.

**Naming:**

```text
tests/contract/**/*.contract.test.ts
tests/contract/**/*.contract.test.tsx
```

**Run:**

```bash
pnpm test:contract
```

### End-to-end tests

Playwright runs browser tests from:

```text
tests/e2e/**/*.e2e.spec.ts
```

**Run:**

```bash
pnpm test:e2e
```

Local E2E tests start the application with `next dev`. In CI, `pnpm verify`
builds the production application first, then Playwright starts it with
`next start`.

The initial browser project is Chromium.

## Common commands

```bash
pnpm test
pnpm test:watch
pnpm test:coverage
pnpm test:e2e
pnpm verify
```

`pnpm test` runs all Vitest projects. It does not run Playwright.

## Coverage

Coverage uses the V8 provider.

**Thresholds:**

- Overall statements: 85%
- Overall branches: 80%
- Domain statements: 95%
- Application statements: 90%

Next.js App Router files and public module entry points are excluded from
coverage measurement.

The coverage report is generated in `coverage/` and is not committed.

## Generated output

The following directories are generated locally and ignored by Git and ESLint:

```text
coverage/
playwright-report/
test-results/
blob-report/
```

## Foundation smoke tests

The initial smoke tests verify that each test project is collected and executed
correctly. They can be removed once each suite contains real project tests.
