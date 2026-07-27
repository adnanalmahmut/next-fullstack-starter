# Next Full-Stack Starter

A production-oriented Next.js starter with TypeScript, internationalized routing, automated testing, and validated environment configuration.

## Requirements

- Node.js 24.13.x
- pnpm 10.29.x

Use the versions declared in `.nvmrc`, `package.json`, and the `packageManager` field.

## Getting Started

Install dependencies:

```bash
pnpm install
```

Create the local environment file:

```bash
cp .env.example .env.local
```

Start the development server:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Verification

Run the main quality gate:

```bash
pnpm verify
```

Run browser tests:

```bash
pnpm test:e2e
```

The `Verify` CI job runs formatting checks, ESLint, TypeScript checks, test coverage, the production build, and Playwright tests.

## Environment Configuration

Environment variables are validated with Zod.

- Server variables are exposed through `src/config/env/index.server.ts`.
- Public variables are exposed through `src/config/env/index.client.ts`.
- Server configuration is validated when `next.config.ts` is loaded.
- Public variables must use the `NEXT_PUBLIC_` prefix.
- `.env.local` must not be committed.
- `.env.example` documents required configuration.

See [`src/config/README.md`](src/config/README.md) for the complete configuration contract.

## Application Structure

```text
messages/              Translation messages
src/app/               Next.js App Router
src/config/            Validated application configuration
src/i18n/              Internationalization infrastructure
src/modules/           Business modules
src/platform/          Infrastructure adapters
src/shared/            Shared application code
src/ui/                Reusable UI components
tests/                 Integration, contract, and end-to-end tests
```
