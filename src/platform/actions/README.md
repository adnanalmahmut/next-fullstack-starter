# Server Actions

The Server Action adapter. Every Server Action in the application is created here,
so validation, authorization, error normalization, hooks, logging, and result
construction are implemented once.

## Files

| File                           | Responsibility                                                 |
| ------------------------------ | -------------------------------------------------------------- |
| `action-result.ts`             | The client-safe result contract. Imported directly by UI code. |
| `action-definition.ts`         | Authorization modes, the definition shape, and actor typing.   |
| `action-context.ts`            | The context each step receives.                                |
| `action-hooks.ts`              | Hook signatures and the closed set of step names.              |
| `define-action.server.ts`      | The factory and the fixed execution order.                     |
| `cache-invalidation.server.ts` | Declarative post-success invalidation.                         |
| `log-event.ts`                 | Event names and the closed log-field allowlist.                |
| `index.server.ts`              | The controlled server-only entry point.                        |

## Usage

An Action definition file starts with the directive and imports the factory from
the controlled entry point:

```ts
"use server";

import * as z from "zod";

import {
  AUTHORIZATION_MODE,
  defineAction,
} from "@/platform/actions/index.server";

export const createProductAction = defineAction({
  name: "catalog.product.create",
  input: z.object({ title: z.string().trim().min(3) }),
  authorization: { mode: AUTHORIZATION_MODE.ACTOR },
  execute: ({ input, actor }) => createProduct(input, actor),
  revalidate: { paths: [{ path: "/catalog" }] },
});
```

A `"use server"` file may only export async functions, so it must not also export
a type, a constant, or a non-async helper.

Presentation code reads the result through `action-result.ts` directly, so the
factory never enters the client bundle.

## Rules

- The factory is `import "server-only"`. It is not itself an Action file and never
  carries `"use server"`.
- A definition declares; it does not restate. It must not parse its own input,
  read a session, compare a role, evaluate a capability, map an error, build an
  `ActionResult`, or call a cache API.
- A permission is always a `Permission` identifier from the registry. A literal
  capability string does not compile.
- The adapter must not reach Prisma, a database client, a repository, or a business
  module, and must not produce an HTTP response, a redirect, or a cookie mutation.
  `next/cache` is the only Next.js API it may import, and an ESLint boundary
  enforces this.
- A log line carries only the fields `ServerActionLogFields` names. Widening that
  type is the only way to add one.
- `revalidate` is static. A path or tag is never taken from client input.
- `afterSuccess` hooks and cache invalidation are not transactional with the use
  case. A failure there is recorded and the success result stands.

The architectural policy is documented in
[`docs/architecture/server-action-factory.md`](../../../docs/architecture/server-action-factory.md).
