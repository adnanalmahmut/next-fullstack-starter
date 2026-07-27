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
