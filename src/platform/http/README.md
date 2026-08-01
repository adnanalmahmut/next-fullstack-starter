# HTTP

The Route Handler adapter and the HTTP response contract. Every application
endpoint is created here, so request correlation, validation, authorization,
hooks, error normalization, serialization, and logging are implemented once.

## Files

| File                     | Responsibility                                                      |
| ------------------------ | ------------------------------------------------------------------- |
| `http-response.ts`       | The envelope types, the error-code to status map, success statuses. |
| `json-response.ts`       | The only place a value becomes a response body.                     |
| `request-input.ts`       | The only place a query is collected and a body is read.             |
| `route-definition.ts`    | The definition shape, input typing, and the handler signature.      |
| `route-context.ts`       | The context each step receives.                                     |
| `route-hooks.ts`         | Hook signatures, decisions, and the closed set of hook names.       |
| `define-route.server.ts` | The factory and the fixed execution order.                          |
| `log-event.ts`           | Event names and the closed log-field allowlist.                     |
| `index.server.ts`        | The controlled server-only entry point.                             |

## Usage

A `route.ts` imports the factory from the controlled entry point and declares:

```ts
import { adminInputSchemas } from "@/platform/auth/authorization/admin-query";
import { listAdminUsers } from "@/platform/auth/authorization/admin-users.service.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { AUTHORIZATION_MODE, defineRoute } from "@/platform/http/index.server";

export const GET = defineRoute({
  name: "identity.user.list",
  input: { query: adminInputSchemas.usersQuery },
  authorization: {
    mode: AUTHORIZATION_MODE.PERMISSION,
    permission: PERMISSION.IDENTITY_USER_LIST,
  },
  execute: ({ query, actor }) => listAdminUsers({ actor }, query),
});
```

A route file exports HTTP method names and nothing else, and each one is a
`defineRoute` call.

## Rules

- The factory is `import "server-only"`. Application endpoints live under
  `/api/v1`; `/api/auth/[...all]` is provider owned and is never wrapped.
- A definition declares; it does not restate. It must not read a body, parse its
  own input, read a session, compare a role, evaluate a capability, map an error,
  or build a `Response`.
- A permission is always a `Permission` identifier from the registry. A literal
  capability string does not compile.
- `params`, `query`, and `body` are validated independently. A part with no
  schema is never read.
- Every answer is a JSON envelope carrying `x-request-id`. There is no `204`: an
  empty payload is `{"data": null}`.
- The success status is declared statically. A status is never taken from client
  input or from a use case.
- A log line carries only the fields `RouteLogFields` names. Widening that type is
  the only way to add one.
- `afterSuccess`, `audit`, and `afterFailure` are observers. They are not
  transactional with the use case: a failure there is recorded as
  `route.hook_failed` and the original outcome stands.
- The adapter must not reach Prisma, a database client, a repository, or a
  business module, and must not redirect or mutate a cookie. `next/server` is the
  only Next.js API it may import, and an ESLint boundary enforces this.

The architectural policy is documented in
[`docs/architecture/route-handler-factory.md`](../../../docs/architecture/route-handler-factory.md)
and the versioning decision in
[`docs/adr/0001-versioned-api-and-openapi-strategy.md`](../../../docs/adr/0001-versioned-api-and-openapi-strategy.md).
