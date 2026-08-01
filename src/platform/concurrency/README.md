# Concurrency

A rate limiter, an idempotency lifecycle, and a lease lock. All three are
coordination, not correctness: PostgreSQL is where an invariant is enforced.

## Files

| File                       | Responsibility                                             |
| -------------------------- | ---------------------------------------------------------- |
| `availability-policy.ts`   | What a caller wants when Redis is not there.               |
| `redis-access.server.ts`   | The three-state client resolution and the script runner.   |
| `rate-limit.server.ts`     | A fixed-window limiter, atomic in one script.              |
| `idempotency.server.ts`    | `begin` / `complete` / `abort`, guarded by an owner token. |
| `lock.server.ts`           | A lease lock with compare-and-delete release.              |
| `route-adapters.server.ts` | The bridge to `defineRoute`.                               |
| `index.server.ts`          | The controlled server-only entry point.                    |

## Usage

In a route definition:

```ts
export const POST = defineRoute({
  name: "billing.invoice.create",
  authorization: { mode: AUTHORIZATION_MODE.PERMISSION, permission: ... },
  hooks: {
    rateLimit: [
      rateLimitHook({
        limit: 10,
        windowMs: 60_000,
        subject: (context) => context.headers.get("x-forwarded-for") ?? "anonymous",
        fallback: RATE_LIMIT_FALLBACK.DENY,
      }),
    ],
  },
  idempotency: idempotencyLifecycle({
    apiVersion: "v1",
    outputSchema: invoiceSchema,
    policy: AVAILABILITY_POLICY.REQUIRED,
    keyRequired: true,
  }),
  execute: createInvoice,
});
```

Around a background job:

```ts
const result = await withLock(
  {
    identity: { name: "billing.digest" },
    leaseMs: 30_000,
    policy: AVAILABILITY_POLICY.BEST_EFFORT,
  },
  () => sendDigest(),
);
```

## Rules

- Every use names its fallback. There is no default: `required` refuses with
  `DEPENDENCY_UNAVAILABLE` and a 503, `best-effort` runs unprotected and records
  the degradation, and a rate limiter chooses `allow` or `deny`.
- `best-effort` is never acceptable for a financial operation or for anything
  that cannot tolerate being performed twice.
- Every multi-step Redis operation is one Lua script. Keys travel in `KEYS`,
  values in `ARGV`, and no key is built inside Lua.
- A caller-supplied subject is hashed before it becomes part of a key.
- Idempotency is a lifecycle, not a lookup. `begin` claims before the use case
  runs and returns the two settle calls; there is no shared map and nothing
  outlives the request.
- Idempotency is **not** atomic with a PostgreSQL mutation. A crash between the
  commit and `complete` leaves a claim until its TTL expires. A non-repeatable
  operation needs a durable record inside the transaction that writes it.
- A lock lease always has a TTL, waiting is always bounded, and only the owner
  can release or extend. It is not Redlock and it does not protect an invariant
  on its own.
- No `KEYS`, `FLUSHDB`, `FLUSHALL`, `SELECT`, or `SCAN`.
- A log line carries the shared control allowlist and nothing else. Never a key,
  an `Idempotency-Key`, a fingerprint, a lock token, an address, or a raw error.
- No endpoint in this repository is wired to any of these yet. They are adapters
  a definition opts into.

The architectural policy is documented in
[`docs/architecture/cache-and-concurrency-controls.md`](../../../docs/architecture/cache-and-concurrency-controls.md).
