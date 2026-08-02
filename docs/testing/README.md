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

One of them builds and drops its own disposable PostgreSQL schema.
`audit-backfill.integration.test.ts` applies the migration history into a fresh
schema, inserts legacy rows, runs `prisma migrate deploy`, and asserts what the
backfill produced — because reading the SQL is not proof that it copies what it
claims to. It never touches the development database and never resets anything.

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

### Opt-in infrastructure suites

Two suites need real infrastructure and are deliberately outside the default
Vitest configuration, each with its own config file and its own script. They
cannot be reached by `pnpm test`, `pnpm test:unit`, or the coverage run, because
`pnpm verify` has to pass on a machine that has neither Redis nor a worker.

```text
tests/redis/**/*.redis.test.ts    → pnpm test:redis:integration
tests/jobs/**/*.jobs.test.ts      → pnpm test:jobs:integration
```

**Run:**

```bash
pnpm redis:test:up

REDIS_ENABLED=true REDIS_URL=redis://127.0.0.1:6380 pnpm test:redis:integration
JOBS_ENABLED=true JOBS_REDIS_URL=redis://127.0.0.1:6380 pnpm test:jobs:integration
```

The jobs suite needs PostgreSQL as well: the outbox is a table, and the
guarantees under test are transactional. Both scope their keys to a run
identifier — `REDIS_TEST_RUN_ID` and `JOBS_TEST_RUN_ID`, generated when absent —
so two runs against one server cannot see each other's data, and both clean up
only what they created.

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

Next.js App Router files, the proxy composition root, worker process entry
points, and public module entry points are excluded from coverage measurement.

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
