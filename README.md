# Next Full-Stack Starter

A production-oriented Next.js starter with TypeScript, internationalized routing, PostgreSQL, Prisma, validated configuration, and automated testing.

## Technology

- Next.js 16
- React 19
- TypeScript
- PostgreSQL 18
- Prisma 7
- Docker Compose
- Zod
- next-intl
- Vitest
- Playwright
- OpenTelemetry (optional, disabled by default)
- Sentry for server-side error monitoring (optional, disabled by default)

## Requirements

- Node.js 24.13.x
- pnpm 10.29.x
- Docker with Docker Compose

Use the versions declared in `.nvmrc`, `package.json`, and the `packageManager` field.

## Local Setup

Install dependencies:

```bash
pnpm install
```

Create the local Compose configuration:

```bash
cp compose.env.example compose.env
```

Create local database secrets:

```bash
mkdir -p .secrets

python3 - <<'PY'
from pathlib import Path
from secrets import token_hex

directory = Path(".secrets")
directory.mkdir(exist_ok=True)

for name in ("postgres_password", "postgres_test_password"):
    path = directory / name

    if not path.exists():
        path.write_text(token_hex(24) + "\n")
PY

chmod 700 .secrets
chmod 600 .secrets/postgres_password
chmod 600 .secrets/postgres_test_password
```

Create `.env.local` and `.env.test.local` with database URLs matching the generated secrets. See [`src/config/README.md`](src/config/README.md) for the complete setup command and configuration contract.

Start the development and test databases:

```bash
pnpm db:up
pnpm db:test:up
```

Generate Prisma Client:

```bash
pnpm db:generate
```

Start the development server:

```bash
pnpm dev
```

Open `http://localhost:3000`.

## Database Commands

| Command                | Purpose                                                   |
| ---------------------- | --------------------------------------------------------- |
| `pnpm db:up`           | Start the persistent development PostgreSQL service.      |
| `pnpm db:down`         | Stop database services while preserving development data. |
| `pnpm db:reset`        | Stop services and delete the development database volume. |
| `pnpm db:status`       | Display development and test database status.             |
| `pnpm db:logs`         | Follow development PostgreSQL logs.                       |
| `pnpm db:test:up`      | Start the isolated test PostgreSQL service.               |
| `pnpm db:test:down`    | Remove the test PostgreSQL container.                     |
| `pnpm db:test:logs`    | Follow test PostgreSQL logs.                              |
| `pnpm db:format`       | Format the Prisma schema.                                 |
| `pnpm db:format:check` | Check Prisma schema formatting without modifying files.   |
| `pnpm db:validate`     | Validate Prisma configuration and schema.                 |
| `pnpm db:generate`     | Generate the local Prisma Client.                         |

The development database stores data in a Docker volume. The test database uses `tmpfs` and does not persist data after its container is removed.

## Optional Redis Commands

Redis is optional and disabled by default. The application builds, runs, and
passes `pnpm verify` without it. Redis runs as its own Compose project, so these
commands never affect PostgreSQL and the `db:*` commands never affect Redis.

```bash
cp compose.redis.env.example compose.redis.env
pnpm redis:up
```

| Command                | Purpose                                |
| ---------------------- | -------------------------------------- |
| `pnpm redis:up`        | Start the development Redis service.   |
| `pnpm redis:down`      | Stop and remove the Redis services.    |
| `pnpm redis:status`    | Display Redis service status.          |
| `pnpm redis:logs`      | Follow development Redis logs.         |
| `pnpm redis:test:up`   | Start the isolated test Redis service. |
| `pnpm redis:test:down` | Remove the test Redis container.       |
| `pnpm redis:test:logs` | Follow test Redis logs.                |

Enable it by setting `REDIS_ENABLED=true` and `REDIS_URL` in `.env.local`. The
Redis integration suite is opt-in and is not part of `pnpm verify`:

```bash
pnpm redis:test:up

REDIS_ENABLED=true REDIS_URL=redis://127.0.0.1:6380 pnpm test:redis:integration
```

See [`docs/architecture/redis-foundation.md`](docs/architecture/redis-foundation.md),
including how to remove Redis from a generated project.

## Caching and Concurrency

Next.js Cache Components are enabled, with three named cache-life profiles —
`frequent`, `standard`, and `durable` — declared once and consumed by
`next.config.ts`. A cached read declares its profile and its tags by identity:

```ts
export async function readUser(userId: string) {
  "use cache";
  applyCachePolicy(CACHE_PROFILE.STANDARD, userCache.detail(userId));

  return userRepository.findById(userId);
}
```

Redis adds an optional cache-aside read, a fixed-window rate limiter, an
idempotency lifecycle, and lease locks. None of them is a correctness mechanism:
PostgreSQL stays the source of truth, and every use declares what should happen
when Redis is not there. Nothing in this repository is wired to them yet.

See
[`docs/architecture/cache-and-concurrency-controls.md`](docs/architecture/cache-and-concurrency-controls.md).

## Optional Background Jobs

Background jobs are optional and disabled by default. The application builds,
runs, and passes `pnpm verify` and `pnpm test:e2e` with no queue, no worker, and
no queue address.

There are two independent levels. `JOBS_ENABLED` turns on the transactional
outbox, which is a plain insert inside your own transaction and needs no Redis:

```ts
await database.$transaction(async (tx) => {
  const result = await performBusinessMutation(tx);

  await writeOutboxMessage(tx, { job: MY_JOB, payload: { id: result.id } });

  return result;
});
```

`JOBS_REDIS_URL` is needed only to build a queue, a worker, or the dispatcher —
that is, only by the separate worker process. The web application keeps recording
work while Redis and the worker are down.

| Command                      | Purpose                                         |
| ---------------------------- | ----------------------------------------------- |
| `pnpm jobs:worker`           | Run the worker process.                         |
| `pnpm jobs:worker:dev`       | Run the worker in watch mode.                   |
| `pnpm jobs:outbox:once`      | Publish one batch, then exit.                   |
| `pnpm jobs:status`           | Report outbox state from PostgreSQL alone.      |
| `pnpm jobs:health`           | Report worker readiness, then exit with a code. |
| `pnpm test:jobs:integration` | Run the opt-in jobs integration suite.          |

`pnpm jobs:health` is the readiness contract for a worker deployment: it checks
that jobs are enabled, that a queue address is configured, and that PostgreSQL and
the queue's Redis both answer, then exits `0` when ready, `1` when something is
down and may recover, and `78` when the process can never start as configured. It
enqueues nothing, runs no job, opens no port, and closes every connection it
opened. `pnpm jobs:status` keeps its own meaning: outbox counts from PostgreSQL
alone, deliberately without contacting Redis.

The worker is a separate process and is never started by `pnpm dev`, `pnpm
build`, or `pnpm start`. The jobs integration suite is opt-in and is not part of
`pnpm verify`:

```bash
pnpm redis:test:up

JOBS_ENABLED=true JOBS_REDIS_URL=redis://127.0.0.1:6380 pnpm test:jobs:integration
```

Delivery is at-least-once, so handlers are made idempotent with
`runDatabaseJobOnce`. The job registry ships empty: no business job is defined,
and nothing in this repository writes to the outbox yet.

See
[`docs/architecture/background-jobs-and-outbox.md`](docs/architecture/background-jobs-and-outbox.md),
including how to remove background jobs from a generated project.

## Application Audit Trail

`src/platform/audit` records what happened: an actor, an action, a resource, a
result, and validated metadata. It is generic — the platform declares no action
of its own, so a module declares its own and records it without importing
anything from `platform/auth`.

```ts
const documentPublished = defineAuditAction({
  name: "documents.document.published",
  resourceType: "documents.document",
  metadataSchema: z.object({ version: z.number().int().min(1) }).strict(),
});

await database.$transaction(async (tx) => {
  const document = await tx.document.update({ ... });

  await appendAuditRecord(tx, documentPublished, {
    actor,
    resourceId: document.id,
    result: AUDIT_RESULT.SUCCEEDED,
    requestId,
    metadata: { version: document.version },
  });
});
```

The record and the change share a commit. Where there is no transaction to join
— a change a provider already committed — `recordAuditPostCommit` answers `false`
instead of throwing, because a completed change must not become a retryable
failure.

The trail is append-only, needs no Redis and no worker, and is read newest-first
through `/api/v1/admin/audit` and `/[locale]/admin/audit`, bounded and paged by
cursor, behind `audit.record.read`. Adding an audited action needs no migration.

See
[`docs/architecture/application-audit-platform.md`](docs/architecture/application-audit-platform.md).

## Optional Object Storage

Object storage is optional and disabled by default. The application builds,
runs, and passes `pnpm verify` and `pnpm test:e2e` with no bucket, no endpoint,
and no credentials. It is S3-compatible, so the same adapter serves AWS S3,
Cloudflare R2, and MinIO — configured, not re-implemented.

Bytes never pass through Next.js. A module authorizes an upload, the browser
posts the file straight to the object store, and the module finalizes:

```ts
const intent = await createUploadIntent({ policy: invoiceUpload, file });
// The browser POSTs to `intent.upload`, then:
const { object } = await finalizeUploadIntent({
  intentId,
  finalizeToken,
  policy: invoiceUpload,
});
```

Finalization verifies the size, the media type, and the SHA-256 of what actually
arrived, then promotes the staged bytes to a final key the client was never told
and can never write. Reusing the upload form afterwards cannot change what a
module reads.

MinIO runs as its own Compose project, so these commands never affect PostgreSQL
or Redis, and `db:*` and `redis:*` never affect MinIO.

```bash
cp compose.storage.env.example compose.storage.env
pnpm storage:up
```

| Command                         | Purpose                                |
| ------------------------------- | -------------------------------------- |
| `pnpm storage:up`               | Start the development MinIO service.   |
| `pnpm storage:down`             | Stop and remove the MinIO services.    |
| `pnpm storage:status`           | Display MinIO service status.          |
| `pnpm storage:logs`             | Follow development MinIO logs.         |
| `pnpm storage:test:up`          | Start the isolated test MinIO service. |
| `pnpm storage:test:down`        | Remove the test MinIO container.       |
| `pnpm storage:test:logs`        | Follow test MinIO logs.                |
| `pnpm test:storage:integration` | Run the opt-in storage suite.          |

Enable it by setting `STORAGE_ENABLED=true` with a region and a bucket. The
bucket must be private: the application never issues a public URL and never sets
an ACL. The storage integration suite is opt-in and is not part of
`pnpm verify`:

```bash
pnpm storage:test:up

STORAGE_ENABLED=true \
STORAGE_ENDPOINT=http://127.0.0.1:9100 \
STORAGE_REGION=us-east-1 \
STORAGE_BUCKET=nfs-storage-test \
STORAGE_ACCESS_KEY_ID=storagetestuser \
STORAGE_SECRET_ACCESS_KEY=storagetestpassword \
STORAGE_FORCE_PATH_STYLE=true \
pnpm test:storage:integration
```

A declared media type and a matching checksum prove the bytes are the ones the
client promised; they prove nothing about whether the content is safe. Judging
that needs a `StorageContentInspector`, and this repository implements none. The
platform ships no upload policy, no module, no page, and no route.

See
[`docs/architecture/object-storage-and-uploads.md`](docs/architecture/object-storage-and-uploads.md),
including how to remove object storage from a generated project.

## Optional Production Telemetry

Distributed tracing and metrics over OTLP/HTTP, and server-side error monitoring.
Both are optional, both are **off by default**, and they are independent of each
other.

| Command                           | Description                     |
| --------------------------------- | ------------------------------- |
| `pnpm test:telemetry:integration` | Run the opt-in telemetry suite. |

With `TELEMETRY_ENABLED=false` no OpenTelemetry SDK module is ever evaluated: there
is no exporter, no batch queue, no export timer, no DNS lookup, and no socket. With
`ERROR_MONITORING_ENABLED=false` the Sentry SDK is never loaded and no DSN is held.
`pnpm verify`, the production build, and `pnpm test:e2e` all pass with no collector,
no vendor account, and no credential anywhere.

Enable tracing and metrics by setting `TELEMETRY_ENABLED=true` and
`TELEMETRY_OTLP_ENDPOINT` — the collector's base URL; the `/v1/traces` and
`/v1/metrics` paths are appended. There is no default endpoint and no localhost
fallback. Authentication goes in `TELEMETRY_OTLP_HEADERS`, never in the URL.

Enable error monitoring separately with `ERROR_MONITORING_ENABLED=true` and
`SENTRY_DSN`. Sentry reports unexpected failures only: no tracing, no automatic
instrumentation, no session replay, no profiling, no client SDK, and no edge SDK.
Every event is rebuilt from an allowlist, and the exception message is replaced by
a stable error code before it is sent.

The telemetry integration suite is opt-in and needs no service at all — it starts
an ephemeral OTLP receiver on a loopback port inside the test process:

```bash
pnpm test:telemetry:integration
```

A request, the outbox row it commits, and the job that row produces form one trace,
and a jobs integration test proves it against real PostgreSQL and Redis. No
migration was added: the existing `traceparent` and `tracestate` columns are reused.

A span, a metric, and an error report carry identity and an outcome, never content
— no payload, no output, no actor, no header, no cookie, no object key, no SQL, and
no error message. Telemetry failure never changes a response, an `ActionResult`, a
job's retry semantics, or an exit code.

This repository produces signals. It deploys no collector, commits no dashboard,
and defines no alert rule.

See
[`docs/architecture/observability.md`](docs/architecture/observability.md),
including the span and metric catalogs, the attribute allowlists, and how to remove
telemetry from a generated project, and
[`docs/adr/0002-server-error-monitoring.md`](docs/adr/0002-server-error-monitoring.md)
for the error-monitoring decision.

## Verification

Ensure the test database is running:

```bash
pnpm db:test:up
```

Run the main quality gate:

```bash
pnpm verify
```

Run browser tests:

```bash
pnpm test:e2e
```

The `Verify` CI job provisions PostgreSQL and runs Prisma validation and generation, formatting checks, ESLint, TypeScript checks, test coverage, the production build, and Playwright tests.

Every optional area is disabled for that job — Redis, background jobs, object
storage, telemetry, and error monitoring — and each has its own opt-in step with
only the service it needs. That is what makes the default run prove the optionality
contract rather than assume it. No external secret is used by any step: the
telemetry step starts its receiver in-process, and no step ever sets a Sentry DSN.

## Configuration and Secrets

Application configuration is validated with Zod.

- Server variables are exposed through `src/config/env/index.server.ts`.
- Public variables are exposed through `src/config/env/index.client.ts`.
- Server configuration is validated when `next.config.ts` is loaded.
- Prisma CLI configuration loads the same environment files through `@next/env`.
- Public variables must use the `NEXT_PUBLIC_` prefix.
- `.env.local`, `.env.test.local`, `compose.env`, and `.secrets/` must not be committed.
- `.env.example` and `compose.env.example` document required configuration.

Docker Compose Secrets prevent database passwords from being exposed through `POSTGRES_PASSWORD` inside containers. Local secret files remain plaintext files on the host and must be protected by filesystem permissions.

See [`src/config/README.md`](src/config/README.md) for the complete configuration contract.

## Application Structure

```text
compose.yaml          Local PostgreSQL development and test services
messages/             Translation messages
prisma/               Prisma schema and migrations
src/app/               Next.js App Router
src/config/            Validated application configuration
src/generated/         Generated source code excluded from version control
src/i18n/              Internationalization infrastructure
src/modules/           Business modules
src/platform/          Infrastructure and framework adapters
src/shared/            Shared application code
src/ui/                Reusable UI components
tests/                 Integration, contract, and end-to-end tests
```
