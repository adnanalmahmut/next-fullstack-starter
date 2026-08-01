# Background Jobs and Transactional Outbox

Work that must happen but must not happen inside a request: sending a
notification, rebuilding a projection, calling a slow provider. This document
describes how such work is recorded, published, executed, retried, and given up
on — and what this project deliberately refuses to promise about it.

Three properties hold throughout, and everything else follows from them.

**PostgreSQL is the durable source.** A job exists because a committed row says
so. Redis holds delivery state and may be lost entirely without losing a single
piece of work.

**Background jobs are optional.** With `JOBS_ENABLED=false` — the default — there
is no queue, no worker, no `ioredis` connection, no socket, no polling loop, and
no requirement for any address. `pnpm dev`, `pnpm build`, `pnpm verify`, and
`pnpm test:e2e` all pass with nothing running.

**Delivery is at-least-once.** Not exactly-once. Anyone who tells you their queue
is exactly-once is describing an effect, not a delivery, and this project says so
out loud rather than in a footnote.

## Optionality

There are two independent levels, and the distinction is the contract:

| Setting          | What it turns on                              | Needs Redis |
| ---------------- | --------------------------------------------- | ----------- |
| `JOBS_ENABLED`   | Recording work in the outbox                  | No          |
| `JOBS_REDIS_URL` | Building a queue, a worker, or the dispatcher | Yes         |

Writing an outbox row is an insert inside the caller's transaction. It contacts
nothing. That is what lets the web application keep accepting work while Redis is
down and the worker is being redeployed: the rows accumulate, and the next
dispatcher drains them.

`JOBS_REDIS_URL` is read by exactly one function, `getJobsRedisConfiguration()`,
and only the queue, the worker, and the dispatcher call it. Nothing on the
request path ever does.

There is no default URL and no fallback to `localhost`. An enabled queue with no
address is a configuration mistake, not something to guess at.

## When to use a job

- The work is slow, and the caller should not wait for it.
- The work may fail independently of the request, and should be retried on its
  own schedule.
- The work must survive the process that requested it.
- The work is a consequence of a committed change rather than part of it.

## When not to use a job

- **Anything the caller's correctness depends on.** If the response would be
  wrong without it, it belongs in the transaction.
- **Anything that must happen exactly once against an external system.** A queue
  cannot give you that; the provider's own idempotency key can.
- **Fan-out of unrelated effects.** One handler that charges a card, writes a
  row, and sends a receipt has three different failure modes and one retry
  policy. Split it.
- **Scheduling.** There is no cron, no repeatable job, and no delayed-until-date
  scheduler here beyond `availableAt`. Adding one is a separate decision.

## Enabling jobs locally

```bash
cp compose.redis.env.example compose.redis.env   # if you have not already
pnpm redis:up
```

Then, in `.env.local`:

```dotenv
JOBS_ENABLED=true
JOBS_REDIS_URL=redis://127.0.0.1:6379
```

Start the worker in its own terminal:

```bash
pnpm jobs:worker:dev
```

The application does not start it, and neither does `pnpm dev`.

Two other entry points help while working:

```bash
pnpm jobs:status        # what the outbox looks like, from PostgreSQL alone
pnpm jobs:outbox:once   # one dispatch pass, then exit
```

`pnpm jobs:status` deliberately does not contact Redis. The moment you most want
it is the moment Redis is down.

## Enabling jobs in a deployment

Run the worker as a **separate process** — a second service, a second container,
a second dyno — with the same image and the same database.

```
web:    pnpm start
worker: pnpm jobs:worker
```

Never inside a serverless function. A platform that freezes a function between
invocations will freeze a worker mid-job, and the job will stall.

Scale the worker independently of the web tier. Two or more workers are safe:
the dispatcher claims rows with `FOR UPDATE SKIP LOCKED`, so they never collide,
and handlers are idempotent, so a redelivery is harmless.

Send `SIGTERM` to the worker process itself, not to a package-manager wrapper
around it. `pnpm jobs:worker` is convenient locally, but a supervisor that
signals `pnpm` may kill it without the worker ever seeing the signal, and the
graceful drain is skipped. In a container, make the worker PID 1:

```dockerfile
CMD ["node_modules/.bin/tsx", "--conditions=react-server", "src/worker/jobs.worker.ts"]
```

## Configuration

| Variable                          | Default                       | Bounds                                            |
| --------------------------------- | ----------------------------- | ------------------------------------------------- |
| `JOBS_ENABLED`                    | `false`                       | `true` or `false`, exactly                        |
| `JOBS_REDIS_URL`                  | _(none)_                      | `redis://` or `rediss://` only                    |
| `JOBS_QUEUE_PREFIX`               | `next-fullstack-starter-jobs` | key-shaped, ≤ 64 chars                            |
| `JOBS_WORKER_CONCURRENCY`         | `5`                           | 1–64                                              |
| `JOBS_WORKER_SHUTDOWN_TIMEOUT_MS` | `30000`                       | 1 000–300 000                                     |
| `OUTBOX_BATCH_SIZE`               | `25`                          | 1–500                                             |
| `OUTBOX_POLL_INTERVAL_MS`         | `1000`                        | 50–60 000                                         |
| `OUTBOX_LEASE_MS`                 | `30000`                       | 1 000–600 000, and greater than the poll interval |
| `OUTBOX_MAX_PUBLISH_ATTEMPTS`     | `10`                          | 1–50                                              |
| `OUTBOX_BACKOFF_BASE_MS`          | `1000`                        | 50–60 000                                         |

Every number is bounded on both ends. The schema is strict, so a typo in a
variable name is a startup failure rather than a silently ignored setting.

The configuration is read lazily and memoized: importing a jobs module reads no
environment variable and opens no socket.

## Job definitions

A job is declared once, with `defineJob`, and the declaration is the whole
contract:

```ts
export const SEND_INVOICE_JOB = defineJob({
  name: "billing.invoice-send",
  version: 1,
  payloadSchema: z.object({ invoiceId: z.uuid() }).strict(),
  resultSchema: z.object({ providerId: z.string() }).strict(),
  attempts: 5,
  backoff: { type: "exponential", delayMs: 1_000 },
  timeoutMs: 30_000,
  timeoutRetryable: true,
  idempotency: { key: (payload) => payload.invoiceId },
  handle: async ({ payload, signal, context }) => {
    /* … */
  },
});
```

The name is `module.operation`, lowercase and dotted. The version is a positive
integer, and `name.v<version>` is the job's full identity — the name BullMQ sees,
so a version bump is visible in the queue and in the failed set without opening a
payload.

Two versions of one job coexist happily. That is the point of the version: a v2
that fixes a calculation must be free to run over a row v1 already touched.

### The registry

`JOB_REGISTRY` in `src/platform/jobs/definitions/registry.ts` is the closed set a
worker knows how to run. It ships **empty**, and that is deliberate: a starter
that shipped a plausible-looking `email.send` would be shipping a business
decision, a provider, a table, and a failure mode nobody asked for. A project adds
its own definitions there.

A registry is built once, from a list, and is immutable. A duplicate
`name.version` throws at construction — that is, at startup — rather than letting
the second definition quietly shadow the first.

An unknown name and an unsupported version are different facts and get different
answers: the first is a message from another system, the second a message from a
different release of this one.

### The envelope

```ts
type JobEnvelope<TPayload> = {
  jobName: string;
  version: number;
  payload: TPayload;
  outboxId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  traceContext?: { traceparent?: string; tracestate?: string };
};
```

It is validated twice: once when the outbox row is written, so a malformed
message never reaches durable storage, and again inside the worker, because the
row may have been written by an older release and Redis is not a trust boundary.

A payload must be JSON — not a `Date`, not a `Map`, not a `Buffer`, not a class
instance, not `undefined`. Each of those survives `JSON.stringify` as something
else, and the difference only surfaces inside a worker days later. It is also
bounded at 64 KiB.

A payload must never carry a raw request body, a header, a cookie, a password, a
token, or a secret. It carries identifiers; the handler reads what it needs.

## The transactional outbox

The pattern in one sentence: **the business change and the intent to publish it
share a commit.**

```ts
await prisma.$transaction(async (tx) => {
  const invoice = await markInvoiceSent(tx, input);

  await writeOutboxMessage(tx, {
    job: SEND_INVOICE_JOB,
    payload: { invoiceId: invoice.id },
  });

  return invoice;
});
```

`writeOutboxMessage` takes a `Prisma.TransactionClient` and refuses the Prisma
singleton — at runtime, not only in the type, because a `PrismaClient` satisfies
enough of the structural type to be passed by a caller in a hurry and would work
right up until a rollback failed to remove the row.

It opens no Redis connection and calls no queue. Forbidden, and enforced by a
contract test:

- `queue.add` inside a transaction — a network call holding row locks open for
  the duration of somebody else's outage, and able to succeed against a
  transaction that then rolls back;
- an HTTP call inside a transaction, for the same reason;
- fire-and-forget after the transaction — `void doWork()`, `setImmediate`,
  `after()` — which loses the work whenever the process exits first.

If the transaction rolls back, there is no row. If it commits, the row survives a
Redis outage, a worker crash, and a deployment.

### The tables

`outbox_message` holds the message and its delivery state: the job identity, the
payload, the correlation and causation identifiers, the validated trace headers,
`availableAt`, the attempt counter, the lease (`lockedBy`, `lockedUntil`),
`publishedAt`, and the dead-letter columns.

`job_execution_receipt` holds one row per completed database effect, keyed by an
opaque execution key.

Neither stores a raw exception, a stack trace, a connection string, a full header
set, or a secret. `lastErrorCode` and `deadLetterCode` are values from closed
sets — a column that could hold an exception message would eventually hold a
connection string.

Nothing is deleted automatically. "What happened to that message" always has an
answer.

## The dispatcher

The dispatcher runs inside the worker process and is the **only** publisher. Its
two phases are strictly separated.

**Claim** is a short PostgreSQL transaction:

```sql
UPDATE outbox_message SET locked_by = …, locked_until = …, publish_attempts = publish_attempts + 1
 WHERE id IN (
   SELECT id FROM outbox_message
    WHERE published_at IS NULL AND dead_lettered_at IS NULL
      AND available_at <= now()
      AND (locked_until IS NULL OR locked_until <= now())
    ORDER BY available_at, created_at, id
    LIMIT :batch
    FOR UPDATE SKIP LOCKED
 )
```

`SKIP LOCKED` is why two dispatchers need no coordination: each walks past the
rows the other is holding. The trailing `id` makes the sort total, so both agree
on the order. No Redis call happens with this transaction open.

**Publish** happens after the commit: resolve the definition, revalidate the
payload, build the envelope, `queue.add` with `jobId` set to the outbox row's id,
then mark `publishedAt`. A failure clears the lease, moves `availableAt` forward
by an exponential backoff with a deterministic spread, and records a sanitized
code.

### The crash window

There is a gap between `queue.add` succeeding and `publishedAt` being written. A
process that dies inside it leaves a row that looks unpublished and a job that
exists.

The next dispatcher republishes with the **same** `jobId`, and BullMQ refuses to
create a second job while a job with that id is still retained. That is why
completed jobs are kept for 24 hours — far longer than any lease or recovery
window — and why that retention is load-bearing rather than a nicety.

It narrows the window. It does not close it: once the retained job is evicted, a
republish creates a genuinely new job. **Delivery is at-least-once.** Handlers
must be idempotent.

## Retries, backoff, and timeouts

Every definition declares a bounded policy: `attempts` (1–20), a backoff type and
delay (100 ms – 1 h), and `timeoutMs` (100 ms – 10 min). There is no unbounded
retry anywhere.

A **retryable** failure is a plain `Error`. That is the default, because most
failures genuinely are transient and the opposite default would silently drop
work.

A **permanent** failure is a `PermanentJobError`, which the worker turns into
BullMQ's `UnrecoverableError`. Schema validation failures, unknown jobs, and
unsupported versions are all permanent: retrying them spends the whole budget to
arrive at the same answer, later, in a bigger log.

BullMQ has no general per-job execution timeout, so one is built from an
`AbortController`. The signal is aborted and the handler is **still awaited**. A
bare `Promise.race` is the tempting version and the wrong one: it resolves the
caller while the work carries on in the background, still holding a connection,
still about to write — and a second attempt then runs alongside the first.

A handler is expected to pass its `signal` to anything that accepts one. One that
ignores it keeps its worker slot until it finishes, which is visible and bounded
by BullMQ's stalled-job detection, and far better than two copies of one job.

Whether a timeout may be retried is declared per job (`timeoutRetryable`). There
is no safe default: a slow dependency should come back, while work that does not
fit its budget will only burn the retries.

## Idempotent execution

```ts
const outcome = await runDatabaseJobOnce({
  executionKey: context.executionKey,
  jobName: context.jobName,
  jobVersion: context.jobVersion,
  execute: async (tx) => applyEffect(tx, payload),
});
```

One transaction: insert the receipt with `createMany({ skipDuplicates: true })`,
and if the insert changed nothing, the work is already done — return, having done
nothing. Otherwise run the effect against the same transaction and commit both,
or roll back both.

`skipDuplicates` rather than catching a constraint violation, because in
PostgreSQL a failed statement aborts the surrounding transaction and the effect
would then be unrunnable. A `findUnique` followed by a `create` has a window
between the two; the unique index closes it.

The execution key is a SHA-256 of the job name, the job version, and the
**domain's** idempotency key. Neither the BullMQ job id nor the outbox id takes
part: both are transport identifiers, and a redriven message legitimately gets a
new one. Because the key is hashed, the domain key may be a value that must never
appear in a column — an email address, an external account reference.

### What this does not cover

A receipt in PostgreSQL does not make an HTTP call to a payment provider
exactly-once. External integrations need the provider's own idempotency key.
Email and SMS APIs that have none may duplicate; that has to be acceptable before
the job is written. Keep handlers small and atomic — a handler doing three
unrelated things has three delivery guarantees and one retry policy.

## Poison messages and dead-letters

There are two dead-letter stores, and they answer different questions.

**The outbox dead-letter** is for messages that can never be published:

| Code                         | Meaning                                              |
| ---------------------------- | ---------------------------------------------------- |
| `unknown-job`                | No definition is registered under this name          |
| `unsupported-version`        | The name is known, this version is not               |
| `invalid-payload`            | The payload does not satisfy the definition's schema |
| `payload-too-large`          | The payload exceeds the transport limit              |
| `publish-attempts-exhausted` | Publishing kept failing until the budget ran out     |

The row is stamped with `deadLetteredAt` and a code, and is **never deleted
automatically**.

**The BullMQ failed set** is the operational dead-letter store for messages that
were published but could not be executed. `removeOnFail: true` is forbidden;
failed jobs are kept for fourteen days and up to twenty thousand entries, so
there is somewhere to look after an incident. Exhausting the retry budget is
logged as its own event — it is the moment work stops being attempted, and the
one worth alerting on.

No second DLQ queue is added. The failed set already holds the message, the
attempt count, and the failure code, and a second queue would be a second thing
to drain, monitor, and forget about.

## Logging and tracing

Stable event names cover the whole path:

```
outbox.written   outbox.claimed   outbox.published   outbox.publish_failed
outbox.dead_lettered
job.queued  job.started  job.succeeded  job.failed  job.retrying
job.timed_out  job.dead_lettered  job.stalled
queue.producer.connection_failed  queue.worker.connection_failed
worker.started  worker.ready  worker.stopping  worker.stopped
```

The field allowlist is closed:

```
jobName  jobVersion  jobId  outboxId  queueName  attempt  maxAttempts
correlationId  causationId  durationMs  outcome  errorCode  delayMs  batchSize
```

Never logged: a payload, a result, an email address, an IP address, a token, a
header, raw baggage, a Redis URL, a database URL, an exception message, or a
stack trace. A job line is the most tempting place in the system to print the
thing that would explain the failure, and every one of those is durable, shipped
off the box, and outlives the incident.

Tracing uses `@opentelemetry/api` and nothing else. No SDK and no exporter is
installed: the API is a facade, every call is a no-op with nothing registered,
and choosing a vendor is a downstream project's decision. Two spans exist,
`jobs.outbox.publish` and `jobs.execute`. Only W3C `traceparent` and `tracestate`
travel, both validated and bounded; baggage never does, because it is the
propagation header most likely to be carrying a user identifier by the time it
reaches a durable row. Tracing never fails a job.

## The worker process

`src/worker/jobs.worker.ts` owns three things the platform refuses to own: the
signal handlers, the exit code, and the Prisma disconnect. Anything a library
installs on `process` is installed in every process that imports it, including
the test runner.

Startup: load `.env*` and align `NODE_ENV` (before any application import) →
refuse unless `JOBS_ENABLED` → resolve the worker configuration, which is where a
missing `JOBS_REDIS_URL` is caught → open the connections → start the consumer →
start the dispatcher → report readiness → wait.

Shutdown, on `SIGINT` or `SIGTERM`: stop polling → stop accepting → drain within
`JOBS_WORKER_SHUTDOWN_TIMEOUT_MS` → force-close if that budget runs out → close
the queue, the connections, and Prisma. A second signal stops waiting; anything
still running loses its lock and comes back as a stalled job, which is safe
because handlers are idempotent.

`worker.close()` has no timeout of its own, so the whole shutdown is wrapped in
one.

The scripts are prefixed with `tsx --conditions=react-server`. That is not
decoration: the `server-only` marker package resolves to a throwing module under
the default Node conditions, and the `react-server` condition is the one it is
built to answer to.

## Connections

BullMQ runs on `ioredis`, and it is the only `ioredis` in the repository. The
cache and the concurrency controls use the `redis` package through
`@/platform/redis`. The two are kept apart on purpose: BullMQ runs blocking
commands, subscribes, and needs `maxRetriesPerRequest: null` on the consumer
side, which is the opposite of what a cache read wants.

|                        | Producer | Worker                   |
| ---------------------- | -------- | ------------------------ |
| `maxRetriesPerRequest` | 2        | `null`                   |
| `enableOfflineQueue`   | `false`  | `true`                   |
| Reconnect attempts     | bounded  | unbounded, bounded delay |

A dispatcher publishing into a dead Redis must find out in seconds and mark the
row for later. `enableOfflineQueue: false` is the half that matters most: with
buffering on, `queue.add` resolves into a buffer that is discarded when the
process exits, and the dispatcher would mark a row published that was never
published. A consumer, by contrast, sits in a blocking read and should wait for
Redis to come back rather than drop an in-flight job.

Nothing connects at import. `lazyConnect` means the socket opens on the first
command.

## Boundaries

| Area                | May reach                                               | May not                                                                                 |
| ------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/platform/jobs` | database, observability, errors, config                 | app, UI, i18n, React, Next.js, business modules, `@/platform/redis`, cache, concurrency |
| `src/worker`        | `@/platform/jobs/index.server`, database, observability | jobs internals, app routes, UI, the drivers                                             |
| `src/modules`       | the outbox writer, in future                            | `bullmq`, `ioredis`                                                                     |
| `src/app`           | —                                                       | the queue, the worker, the jobs platform                                                |

Enforced by ESLint (`architecture/no-redis-driver-import`,
`architecture/jobs-platform`, `architecture/worker-entry-points`), by
dependency-cruiser (`no-queue-driver-outside-jobs`,
`no-jobs-platform-internal-imports`, `no-jobs-in-request-path`,
`no-jobs-to-redis-platform`, `no-imports-of-worker-entry-points`), and by
contract tests.

`getJobQueue` and `requireJobQueue` are deliberately **not** exported from
`@/platform/jobs/index.server`. Business code enqueues by writing an outbox row;
if it could reach the queue directly it would eventually publish next to a
transaction rather than inside one.

Jobs must not use the Redis key builder. BullMQ manages its own namespace
underneath its own prefix, and a job that borrowed the cache's builder would put
queue keys inside the cache's key space and tie two independently removable areas
together.

## Testing

Unit tests cover the configuration, the definitions, the registry, the envelope,
the failure taxonomy, the timeout, the execution key, the log allowlist, tracing,
the connections, the queue options, the dispatcher, the processor, and the worker
runtime — with the drivers mocked, so `pnpm verify` needs neither Redis nor a
worker.

PostgreSQL integration tests
(`tests/integration/background-jobs-outbox.integration.test.ts`) prove the
transactional guarantees: a change and its outbox row committing together, a
rollback removing both, invisibility before the commit, and an effect and its
receipt committing together.

The jobs integration suite (`tests/jobs`) is the only place a real queue is
required, and it is deliberately outside the default configuration:

```bash
pnpm redis:up
JOBS_ENABLED=true JOBS_REDIS_URL=redis://127.0.0.1:6379 pnpm test:jobs:integration
```

It cannot be reached by `pnpm test`, `pnpm test:unit`, or the coverage run. Every
run uses a queue prefix scoped by `JOBS_TEST_RUN_ID`, so two runs against one
server cannot consume each other's jobs, and cleanup is targeted — the queue this
run created and the rows this run wrote, never `FLUSHDB`, `FLUSHALL`, or `KEYS`.

CI runs `Verify project` and the end-to-end suite with `JOBS_ENABLED=false` and
no `JOBS_REDIS_URL` at all, then the jobs integration suite in one dedicated step
with both set. No long-lived worker runs in CI; the tests manage their own.

## What this change does not do

- No business job is defined. The registry is empty.
- No existing route, Server Action, or admin operation writes to the outbox.
- There is no scheduler, no cron, and no repeatable job.
- There is no queue dashboard, no Bull Board, and no admin UI.
- There is no OpenTelemetry SDK and no exporter.
- There is no second DLQ queue.
- There is no automatic pruning of published or dead-lettered rows.

## Removing background jobs from a generated project

The capability is removable without touching business code:

1. Delete `src/platform/jobs` and `src/worker`.
2. Delete `prisma/jobs.prisma`, and add a migration that drops
   `outbox_message`, `job_execution_receipt`, and the `outbox_dead_letter_code`
   enum.
3. Delete `vitest.jobs.config.ts`, `tests/jobs`, and
   `tests/fixtures/jobs.fixture.ts`.
4. Delete `tests/integration/background-jobs-outbox.integration.test.ts` and
   `tests/contract/background-jobs-outbox.contract.test.ts`.
5. In `package.json`, remove `bullmq`, `ioredis`, `tsx`, and
   `@opentelemetry/api` from the dependencies, and remove the `jobs:worker`,
   `jobs:worker:dev`, `jobs:outbox:once`, `jobs:status`, and
   `test:jobs:integration` scripts.
6. In `src/config/env/schema.ts`, remove the jobs block and `JobsEnvironment`;
   delete `src/config/env/read-jobs.ts` and its tests.
7. In `eslint.config.mjs`, remove the `architecture/jobs-platform` and
   `architecture/worker-entry-points` blocks and the `jobs` and `worker`
   restricted patterns; in `tools/eslint/architecture-plugin.mjs`, drop the
   queue-driver entry from `no-redis-driver-import`.
8. In `.dependency-cruiser.js`, remove the five jobs rules.
9. In `.github/workflows/ci.yml`, remove the `JOBS_ENABLED` variable and the
   `Run jobs integration tests` step.
10. In `.env.example`, remove the jobs block.
11. Delete this document and its entry in `docs/architecture/README.md`.

### What survives

Everything else. No route, Server Action, use case, repository, or component
imports the jobs platform, so nothing above changes application behaviour. The
Redis foundation and the cache and concurrency controls are untouched: they run
on a different driver, through a different entry point, with their own key
namespace, and are removable independently in either order.
