# Configuration

Application configuration is validated with Zod before it is consumed.

## Local Setup

Create the ignored local environment file from the committed example:

```bash
cp .env.example .env.local
```

`next.config.ts` validates the server environment before Next.js enters its build or server phase. Application code accesses the validated values through the server-only entry point.

## Environment Variables

| Variable              | Visibility | Required           | Purpose                                               |
| --------------------- | ---------- | ------------------ | ----------------------------------------------------- |
| `APP_ENV`             | Server     | Yes                | Identifies the application deployment environment.    |
| `NODE_ENV`            | Server     | Managed by Next.js | Identifies the Node.js execution mode.                |
| `NEXT_PUBLIC_APP_URL` | Public     | Yes                | Provides the canonical HTTP or HTTPS application URL. |

### Supported `APP_ENV` Values

- `development`
- `test`
- `staging`
- `production`

### Supported `NODE_ENV` Values

- `development`
- `test`
- `production`

## Import Boundaries

Import server configuration from:

```ts
import { serverEnv } from "@/config/env/index.server";
```

Import public configuration from:

```ts
import { publicEnv } from "@/config/env/index.client";
```

Application modules must not access `process.env` directly. New variables must be declared in the appropriate schema and exposed through the corresponding entry point.

`index.server.ts` imports `server-only`, preventing server configuration from being imported into Client Components.

Only non-secret values may use the `NEXT_PUBLIC_` prefix.

## Adding a Server Variable

1. Add the variable to `serverEnvironmentSchema`.
2. Add its explicit `process.env` lookup to `index.server.ts`.
3. Add it to `.env.example`.
4. Add valid and invalid schema tests.
5. Configure it in CI and deployment environments.

## Adding a Public Variable

1. Prefix the variable with `NEXT_PUBLIC_`.
2. Add it to `publicEnvironmentSchema`.
3. Add its explicit static lookup to `index.client.ts`.
4. Add it to `.env.example`.
5. Add valid and invalid schema tests.
6. Configure it before running `next build`.
