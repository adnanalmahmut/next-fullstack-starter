# Configuration

Application configuration is validated with Zod before it is consumed.

## Configuration Files

| File                        | Version control | Purpose                                             |
| --------------------------- | --------------- | --------------------------------------------------- |
| `.env.example`              | Committed       | Documents application environment variables.        |
| `.env.local`                | Ignored         | Local development application configuration.        |
| `.env.test.local`           | Ignored         | Local test application configuration.               |
| `compose.env.example`       | Committed       | Documents Docker Compose configuration.             |
| `compose.redis.env.example` | Committed       | Documents the optional Redis Compose configuration. |
| `compose.redis.env`         | Ignored         | Local Redis Compose configuration.                  |
| `compose.env`               | Ignored         | Local Docker Compose configuration.                 |
| `.secrets/`                 | Ignored         | Local Docker Compose secret files.                  |

## Local Setup

Create the local Compose configuration:

```bash
cp compose.env.example compose.env
```

Create database passwords:

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

Create application environment files from the Compose configuration and secret files:

```bash
python3 - <<'PY'
from pathlib import Path
from urllib.parse import quote

def read_env(path: str) -> dict[str, str]:
    values: dict[str, str] = {}

    for line in Path(path).read_text().splitlines():
        line = line.strip()

        if not line or line.startswith("#"):
            continue

        key, value = line.split("=", 1)
        values[key] = value

    return values

compose = read_env("compose.env")

development_password = (
    Path(compose["POSTGRES_PASSWORD_FILE"]).read_text().strip()
)
test_password = (
    Path(compose["POSTGRES_TEST_PASSWORD_FILE"]).read_text().strip()
)

development_url = (
    "postgresql://"
    f"{quote(compose['POSTGRES_USER'], safe='')}:"
    f"{quote(development_password, safe='')}@"
    f"127.0.0.1:{compose['POSTGRES_PORT']}/"
    f"{quote(compose['POSTGRES_DB'], safe='')}"
    "?schema=public"
)

test_url = (
    "postgresql://"
    f"{quote(compose['POSTGRES_TEST_USER'], safe='')}:"
    f"{quote(test_password, safe='')}@"
    f"127.0.0.1:{compose['POSTGRES_TEST_PORT']}/"
    f"{quote(compose['POSTGRES_TEST_DB'], safe='')}"
    "?schema=public"
)

Path(".env.local").write_text(
    "\n".join(
        [
            "APP_ENV=development",
            f"DATABASE_URL={development_url}",
            "NEXT_PUBLIC_APP_URL=http://localhost:3000",
            "",
        ]
    )
)

Path(".env.test.local").write_text(
    "\n".join(
        [
            "APP_ENV=test",
            f"DATABASE_URL={test_url}",
            "NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100",
            "",
        ]
    )
)
PY
```

Start the databases:

```bash
pnpm db:up
pnpm db:test:up
```

## Environment Variables

| Variable              | Visibility | Required           | Purpose                                               |
| --------------------- | ---------- | ------------------ | ----------------------------------------------------- |
| `APP_ENV`             | Server     | Yes                | Identifies the application deployment environment.    |
| `DATABASE_URL`        | Server     | Yes                | Provides the PostgreSQL connection URL.               |
| `NODE_ENV`            | Server     | Managed by runtime | Identifies the Node.js execution mode.                |
| `NEXT_PUBLIC_APP_URL` | Public     | Yes                | Provides the canonical HTTP or HTTPS application URL. |

### Optional Redis Variables

Redis is optional. With none of these set the application runs, builds, and
passes `pnpm verify` without ever contacting Redis.

| Variable                   | Visibility | Required          | Purpose                                                             |
| -------------------------- | ---------- | ----------------- | ------------------------------------------------------------------- |
| `REDIS_ENABLED`            | Server     | No                | Turns Redis on. `true` or `false`, default `false`.                 |
| `REDIS_URL`                | Server     | Only when enabled | `redis://` or `rediss://` connection URL. No default.               |
| `REDIS_KEY_PREFIX`         | Server     | No                | First segment of every key. Default `next-fullstack-starter`.       |
| `REDIS_CONNECT_TIMEOUT_MS` | Server     | No                | Bounded connect timeout, 100-30000. Default `5000`.                 |
| `REDIS_TEST_RUN_ID`        | Server     | No                | Isolates one test run's keys. Generated when absent.                |
| `REDIS_TEST_WORKER_ID`     | Server     | No                | Isolates one worker of a run. Falls back to the runner's worker id. |

These are deliberately absent from `serverEnvironmentSchema` and from
`index.server.ts`. Startup never reads them, so a missing `REDIS_URL` cannot fail
validation the way a missing `DATABASE_URL` does; `src/platform/redis/config.ts`
reads them lazily on first use. See
[`docs/architecture/redis-foundation.md`](../../docs/architecture/redis-foundation.md).

### Optional Background-Jobs Variables

Background jobs are optional, and come in two independent levels. With none of
these set the application runs, builds, and passes `pnpm verify` and
`pnpm test:e2e` with no queue and no worker.

| Variable                          | Visibility | Required         | Purpose                                                                |
| --------------------------------- | ---------- | ---------------- | ---------------------------------------------------------------------- |
| `JOBS_ENABLED`                    | Server     | No               | Turns the outbox on. `true` or `false`, default `false`.               |
| `JOBS_REDIS_URL`                  | Server     | Only for a queue | `redis://` or `rediss://` connection URL. No default.                  |
| `JOBS_QUEUE_PREFIX`               | Server     | No               | BullMQ key prefix. Default `next-fullstack-starter-jobs`.              |
| `JOBS_WORKER_CONCURRENCY`         | Server     | No               | Jobs one worker runs at once, 1-64. Default `5`.                       |
| `JOBS_WORKER_SHUTDOWN_TIMEOUT_MS` | Server     | No               | Drain budget on shutdown, 1000-300000. Default `30000`.                |
| `OUTBOX_BATCH_SIZE`               | Server     | No               | Rows claimed per pass, 1-500. Default `25`.                            |
| `OUTBOX_POLL_INTERVAL_MS`         | Server     | No               | Wait after an empty pass, 50-60000. Default `1000`.                    |
| `OUTBOX_LEASE_MS`                 | Server     | No               | Claim lease, 1000-600000 and above the poll interval. Default `30000`. |
| `OUTBOX_MAX_PUBLISH_ATTEMPTS`     | Server     | No               | Publish attempts before dead-lettering, 1-50. Default `10`.            |
| `OUTBOX_BACKOFF_BASE_MS`          | Server     | No               | First publish backoff, 50-60000. Default `1000`.                       |
| `JOBS_TEST_RUN_ID`                | Server     | No               | Isolates one test run's queue. Generated when absent.                  |

`JOBS_ENABLED` and `JOBS_REDIS_URL` are separate on purpose. Writing an outbox row
is an insert inside the caller's transaction, so it needs the flag and no address;
only a queue, a worker, or the dispatcher needs the address, and only
`getJobsRedisConfiguration()` reads it. That is what lets the application keep
recording work while Redis and the worker are down.

Like the Redis block, these are absent from `serverEnvironmentSchema` and from
`index.server.ts`, and `src/platform/jobs/config/jobs-config.ts` reads them lazily
on first use. See
[`docs/architecture/background-jobs-and-outbox.md`](../../docs/architecture/background-jobs-and-outbox.md).

### Supported `APP_ENV` Values

- `development`
- `test`
- `staging`
- `production`

### Supported `NODE_ENV` Values

- `development`
- `test`
- `production`

`DATABASE_URL` must use the `postgresql://` or `postgres://` protocol.

## Environment Loading

Next.js loads application environment files according to its environment loading rules.

During tests, `NODE_ENV` is `test`. The integration test therefore uses `.env.test.local`, not `.env.local`.

`prisma.config.ts` calls `loadEnvConfig` from `@next/env` before validating `DATABASE_URL`. This keeps Prisma CLI commands aligned with the application's environment loading behavior.

Explicit process environment variables take precedence over local environment files. CI provides its test configuration directly through the workflow environment.

## Import Boundaries

Import server and database configuration from:

```ts
import { databaseEnv, serverEnv } from "@/config/env/index.server";
```

Import public configuration from:

```ts
import { publicEnv } from "@/config/env/index.client";
```

Application modules must not access `process.env` directly. New variables must be declared in the appropriate schema and exposed through a controlled entry point.

`index.server.ts` imports `server-only`, preventing server configuration and database credentials from being imported into Client Components.

Only non-secret values may use the `NEXT_PUBLIC_` prefix.

## Docker Compose Secrets

The Compose services receive database passwords through:

```text
/run/secrets/postgres_password
/run/secrets/postgres_test_password
```

The passwords are not passed through `POSTGRES_PASSWORD`.

Docker Compose Secrets protect the password from container environment inspection, but local secret files remain plaintext on the host. They must remain ignored by Git and use restrictive filesystem permissions.

Production deployments should use the target platform's managed secret store rather than copying the local `.secrets/` directory.

## Adding a Server Variable

1. Add the variable to the appropriate Zod schema.
2. Add its explicit `process.env` lookup to the corresponding reader.
3. Expose it through `index.server.ts` when application code needs it.
4. Add it to `.env.example`.
5. Add valid and invalid schema tests.
6. Configure it in CI and deployment environments.

## Adding a Public Variable

1. Prefix the variable with `NEXT_PUBLIC_`.
2. Add it to `publicEnvironmentSchema`.
3. Add its explicit static lookup to `index.client.ts`.
4. Add it to `.env.example`.
5. Add valid and invalid schema tests.
6. Configure it before running `next build`.
