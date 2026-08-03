# Operational Health

Two HTTP probes and one worker command, so a load balancer, an orchestrator, and
a deployment gate can each ask a question they can act on:

```text
GET  /api/health/live     is this process running?
GET  /api/health/ready     can this process serve traffic?
pnpm jobs:health           can this worker consume its queue?
```

The design is **process-aware**. A web process and a worker process fail for
different reasons, recover in different ways, and are steered by different
machinery, so they get different contracts. The single most damaging mistake in
this area is one contract for both: it produces an orchestrator that restarts a
healthy web instance because a queue is down, or a load balancer that drains a
perfectly good instance because a worker deployment is broken.

The implementation lives in `src/platform/health`, with the PostgreSQL check
owned by `src/platform/database` and the queue check owned by
`src/platform/jobs`.

## Liveness versus readiness

They answer different questions and are wired to different actions. Conflating
them is the classic operational bug in this area.

|               | Liveness                       | Readiness                              |
| ------------- | ------------------------------ | -------------------------------------- |
| Question      | is the process running?        | can it serve traffic?                  |
| Wired to      | restart policy                 | load balancer rotation                 |
| Dependencies  | **none**                       | PostgreSQL, plus enabled optional ones |
| Answers       | `200`, always                  | `200` or `503`                         |
| Cost          | no I/O at all                  | one bounded call per dependency        |
| Failure means | the process is wedged; kill it | take it out of rotation; keep probing  |

**Liveness checks nothing.** A process that produced the response is running, and
that is the whole question. A liveness probe that consulted a database would
eventually be wired to a restart policy, and an orchestrator would start killing
healthy processes every time something they do not own went away — turning a
brief database blip into a rolling restart of the entire fleet.

**Readiness checks what a request needs.** PostgreSQL always; Redis and object
storage only when they are switched on. A dependency that is switched off is a
deployment choice and is reported as `disabled`, never as a fault.

## Response contracts

Both are flat JSON documents. Neither uses the `{"data": …}` envelope of the
versioned API, because an operational probe is consumed by tooling that matches
on the document itself, and a `503` here is not an error — nothing failed, a
dependency is simply absent.

### Liveness

```http
GET /api/health/live
200 OK
Cache-Control: no-store
Content-Type: application/json
```

```json
{ "status": "live", "code": "PROCESS_ALIVE" }
```

The body is a constant. It carries no timestamp, no hostname, no process id, no
uptime, no memory figure, no version, no commit, and no dependency status. Every
one of those is infrastructure detail on an endpoint that is reachable without
authentication, and a body that changed between requests would defeat the
cheapest thing an external monitor can do with it — compare the bytes.

### Readiness

```http
GET /api/health/ready
200 OK
Cache-Control: no-store
Content-Type: application/json
```

```json
{
  "status": "ready",
  "code": "READY",
  "checks": {
    "database": { "status": "healthy" },
    "redis": { "status": "disabled" },
    "storage": { "status": "disabled" }
  }
}
```

And when a required dependency does not answer:

```http
503 Service Unavailable
Cache-Control: no-store
```

```json
{
  "status": "not_ready",
  "code": "NOT_READY",
  "checks": {
    "database": { "status": "unhealthy", "code": "DATABASE_UNAVAILABLE" },
    "redis": { "status": "healthy" },
    "storage": { "status": "disabled" }
  }
}
```

The shape is total: every dependency the registry declares appears in `checks`
whether it is healthy, unhealthy, or switched off. Omitting the disabled ones
would make "we do not run Redis here" and "the Redis check was never wired up"
look identical to whoever is reading it during an incident.

What is deliberately absent from both documents:

- **No human message.** No `message`, no `detail`, no `reason`. A field that can
  hold a sentence is a field that will eventually hold an exception.
- **No `latencyMs`.** It is a fingerprint of the infrastructure and it makes the
  body change on every request. It is kept in the internal typed result and in
  the structured log line, which are both safe places for it.
- **No timestamp.** The answer is about now by definition, and the response is
  `no-store`.
- **No URL, host, port, bucket, endpoint, queue name, or credential.**
- **No provider payload and no stack trace.**

### `no-store` is load-bearing

A readiness answer that a CDN, a reverse proxy, or a browser may reuse is worse
than no answer at all: a cached `200` keeps sending traffic to an instance that
has already lost its database, and a cached `503` keeps traffic away from one
that recovered a minute ago. Liveness sets it too — partly for the same reason,
partly so the two endpoints do not differ in a way somebody has to remember.

### HTTP status semantics

| Status | Meaning                            |
| ------ | ---------------------------------- |
| `200`  | every required dependency answered |
| `503`  | at least one did not               |

`503` rather than `500`, because the process is working correctly and telling the
truth about something it depends on. That is a dependency failure, not an
application fault, and `503` is the status a load balancer already knows how to
read. A `500` would invite an alert about the endpoint itself.

Neither status is influenced by anything a client sends: there is no query
parameter, no header, and no body that can change the answer. There is no
redirect and no localization — a probe is called by a machine that will not
follow one and does not read prose.

## Stable codes

Closed, published, and gathered in one file, `health-code.ts`. These are the part
of this platform that something outside the repository depends on — a load
balancer rule, a deployment gate, an alert, a runbook — so changing one is a
breaking change to an operational integration.

| Code                     | Meaning                                                |
| ------------------------ | ------------------------------------------------------ |
| `PROCESS_ALIVE`          | the process is running and serving                     |
| `READY`                  | every required dependency answered                     |
| `NOT_READY`              | at least one did not                                   |
| `DATABASE_UNAVAILABLE`   | PostgreSQL did not answer within its budget            |
| `REDIS_UNAVAILABLE`      | Redis is enabled and did not answer                    |
| `STORAGE_UNAVAILABLE`    | the object store could not be reached — retryable      |
| `STORAGE_MISCONFIGURED`  | the object store answered and refused — needs a deploy |
| `WORKER_READY`           | the worker's dependencies all answered                 |
| `WORKER_NOT_READY`       | configured correctly, something did not answer         |
| `WORKER_MISCONFIGURED`   | the worker cannot run as configured                    |
| `JOBS_REDIS_UNAVAILABLE` | the queue's Redis did not answer                       |

Three properties hold:

- They are **language-neutral identifiers**, never prose. There is nothing to
  translate and no sentence to reword.
- They are **never derived from an error** — not from a message, not from a class
  name, not from a provider's code. A code taken from an exception would carry
  whatever the exception carried, and the set would stop being closed the first
  time a driver changed its wording.
- They **name a condition, not a provider**. `STORAGE_UNAVAILABLE` says the
  bucket could not be reached; it does not say which bucket, which endpoint, or
  which vendor.

`DATABASE_UNAVAILABLE`, `REDIS_UNAVAILABLE`, and `JOBS_REDIS_UNAVAILABLE` are
also declared by the areas that own those checks, so each area can answer without
depending on this platform. A unit test asserts the two spellings are the same
string, so they cannot drift apart unnoticed.

## Web readiness dependencies

| Dependency     | Checked                          | Disabled behaviour      | Unhealthy behaviour |
| -------------- | -------------------------------- | ----------------------- | ------------------- |
| PostgreSQL     | always                           | n/a — not optional      | `503`               |
| Redis cache    | only when `REDIS_ENABLED=true`   | `disabled`, still ready | `503`               |
| Object storage | only when `STORAGE_ENABLED=true` | `disabled`, still ready | `503`               |
| Queue Redis    | **never**                        | —                       | —                   |
| BullMQ worker  | **never**                        | —                       | —                   |
| Outbox backlog | **never**                        | —                       | —                   |

### PostgreSQL

`checkDatabaseHealth()` in `src/platform/database`. It sends `SELECT 1` as a
tagged template — never `$queryRawUnsafe`, and the check takes no input at all,
so there is no string a caller could influence. It reads no table, touches no
business row, creates nothing, and changes nothing, so running it on every probe
of every process forever costs one round trip and leaves no trace. It uses the
shared client, so a probe never opens a pool of its own.

There is no `disabled` outcome. PostgreSQL is the one dependency this application
cannot serve a request without, and there is no configuration in which being
unable to reach it becomes acceptable.

### Redis

`checkRedisHealth()`, reused unchanged from the Redis foundation. This platform
re-implements no ping. With `REDIS_ENABLED=false` the answer comes from
configuration alone: no client is constructed, no socket is opened, and no name is
resolved — so a readiness probe on a project that caches nothing costs nothing at
all, even when a Redis server happens to be running next to it. The integration
suite asserts exactly that, with a real server available.

### Object storage

`checkStorageHealth()`, reused unchanged. The two failure modes stay
distinguishable, and that distinction is the operational point rather than a
detail:

- `STORAGE_UNAVAILABLE` — could not be reached or did not answer in time. **Wait
  and retry.**
- `STORAGE_MISCONFIGURED` — the provider answered and refused: the bucket does
  not exist, the credentials are rejected, or the variables do not parse.
  **Somebody has to deploy a change.**

A probe that reported one as the other would send an operator looking in the
wrong place. Both make the process unready; neither names the bucket, the
endpoint, or the provider's response. The probe is a `HeadBucket` — a metadata
call that creates nothing, so it cannot fill a bucket with garbage and does not
need write credentials.

### Why web readiness does not check the worker

Because a web process does not need one. Work is recorded by writing a
transactional outbox row **inside the transaction that earns it**: an insert into
PostgreSQL, needing no queue address and no Redis. A request therefore completes
correctly with `JOBS_ENABLED=false`, with no `JOBS_REDIS_URL` anywhere, and with
no worker process running at all.

Checking the queue here would mean a web deployment reports itself unready
because a _different_ deployment is down, and a load balancer would drain traffic
from instances that were serving every request perfectly. The queue backlog would
grow — which is exactly what an outbox is for — and the site would go down for
no reason.

The same reasoning excludes outbox backlog depth and queue depth. A queue with
work waiting in it is a queue that is working.

Better Auth, the cache, and the concurrency controls are also not probed
separately: authentication reads the database this check already covers, and the
limiter, the idempotency store, and the lock all run on the Redis it already
covers — each with its own named fallback for a Redis that will not answer.

## Worker readiness

`pnpm jobs:health` is a one-shot command. It opens bounded connections, asks two
questions, closes everything in a `finally`, writes one structured line, and sets
an exit code.

| Dependency          | Requirement                              |
| ------------------- | ---------------------------------------- |
| `JOBS_ENABLED=true` | required — `false` is a misconfiguration |
| `JOBS_REDIS_URL`    | required                                 |
| PostgreSQL          | must answer                              |
| Queue Redis         | must answer                              |
| Job registry        | must be constructible                    |

### Exit codes

It reuses the existing `WORKER_EXIT_CODE` and adds none.

| Exit | Verdict       | Code                   | What a supervisor should do             |
| ---- | ------------- | ---------------------- | --------------------------------------- |
| `0`  | ready         | `WORKER_READY`         | nothing                                 |
| `1`  | not ready     | `WORKER_NOT_READY`     | keep trying — this may recover          |
| `78` | misconfigured | `WORKER_MISCONFIGURED` | stop restarting; a variable must change |

`78` is separate from `1` so a supervisor can tell "this will never start until
someone edits a variable" from "this crashed and may come back", and stop
restarting the first one in a tight loop.

**`JOBS_ENABLED=false` is a misconfiguration here and normal everywhere else.**
In a worker deployment it means the process was started to consume a queue it has
been told not to consume, so reporting ready would be reporting a deployment
mistake as success. It never makes the web process unready.

On the misconfigured path no connection is opened at all, and both dependency
statuses are reported as `disabled` rather than guessed at: nothing useful is
learned from a database a misconfigured process will never use, and claiming a
status it never checked would be inventing a fact.

### What it does not do

- **Enqueues nothing.** No probe job, no test message. A check that added one
  would leave a message in the queue every time it ran, need a consumer that knew
  to discard it, and fail on read-only credentials.
- **Executes no job**, writes no outbox row, reads no outbox row, and creates no
  receipt.
- **Opens no port.** See below.
- **Leaves no connection open.** The queue probe closes its connection on every
  path, and the command disconnects Prisma in a `finally`.

### Why the worker runs no HTTP server

A worker that listened on a port would need a service, an ingress, a port
assignment, and a second unauthenticated surface to defend — and it would then be
a web process with a consumer bolted on rather than a worker. A supervisor that
needs a probe runs the command; the exit code is the answer, and that is the
interface a container health check, a Kubernetes exec probe, and a deployment step
all already speak.

### `jobs:health` versus `jobs:status`

`jobs:status` is unchanged and keeps its meaning. It answers "what is in the
outbox" from PostgreSQL alone and deliberately never contacts Redis, because the
moment you most want it is the moment Redis is down. That makes it the wrong
command for readiness — a worker whose queue is unreachable would report a
perfectly healthy outbox — so readiness is a separate command rather than a new
mode of that one.

## Timeouts

Every check is bounded, and each one is bounded **independently**.

| Check                | Budget   |
| -------------------- | -------- |
| PostgreSQL (web)     | 2 000 ms |
| Redis (web)          | 1 500 ms |
| Object storage (web) | 3 000 ms |
| PostgreSQL (worker)  | 2 000 ms |
| Queue Redis (worker) | 5 000 ms |

The registry refuses anything outside 100–5 000 ms. A check given a few
milliseconds would report a healthy dependency as unavailable under any load at
all; a check allowed to wait a minute would keep the endpoint open long enough
for a load balancer's probes to queue up behind each other.

A shared deadline is deliberately not used. The calls are not comparable — a
`SELECT 1` on a warm pool answers in single-digit milliseconds while a
`HeadBucket` may cross a region — and one budget would let a slow _optional_
dependency consume the time a _required_ one needed, producing the exact
inversion a readiness probe must never produce.

The checks run concurrently, so a probe takes as long as its slowest dependency
rather than the sum of all of them. Concurrency is bounded by construction: the
registry is a fixed, small, immutable list built at composition, so no input can
widen it.

Every timer is cleared on every path — success, failure, and timeout. A readiness
endpoint is called for the lifetime of a deployment, and a timer left behind on
any path is a leak that only shows up in a long-running process.

A timed-out PostgreSQL query is not cancelled; the server keeps running it and
the connection returns to the pool when it finishes. That is a deliberate trade:
the alternative is a cancellation path that has to be correct under exactly the
conditions in which nothing is working.

## Failure containment

Nothing propagates out of a probe.

- A check that rejects, throws synchronously, returns a rejected promise, or
  never settles all produce the same thing: an `unhealthy` report carrying the
  code that check declared.
- The caught value is never read. Not the message, not the class name, not the
  provider's code — reading it is how a connection string reaches a public
  document.
- The failure code is **declared** by each check, not derived from what was
  thrown.
- If aggregation itself fails — a malformed registry, a logger that throws — the
  handler answers the ordinary `not_ready` document with `503` rather than
  letting a `500` with a stack trace out of an unauthenticated endpoint. A
  process that cannot assemble its own readiness report is not ready, and saying
  so with the normal contract is the honest answer.
- No probe writes to `console`, terminates the process, or produces an unhandled
  rejection.
- No retries. A probe is asking about now; a retry would answer about a few
  seconds ago and delay the verdict past the interval it is called on.

### No caching

Probe results are never cached, in any sense: no `"use cache"`, no
`@/platform/cache`, no memoized last answer. A stale success hiding a current
failure is the one thing a readiness endpoint must never do.

## Request-time rendering

This project runs with Cache Components enabled (`cacheComponents: true`). Under
it, a `GET` Route Handler that reads no request data and performs no uncached I/O
is **prerendered at build time**.

Both handlers therefore `await connection()` before doing anything. Without it:

- Liveness would be turned into a static document produced by `next build`
  rather than by the process being probed, carrying whatever headers the static
  path chose rather than the `no-store` this platform guarantees.
- Readiness would depend on `next build` correctly detecting a Prisma query in
  order to defer; if it did not, the build would run the checks against whatever
  the build machine could reach and freeze that answer into a static file.

`export const dynamic = "force-dynamic"` is **not** an alternative: it was
removed in Next.js 16 when Cache Components is enabled. `connection()` is the
supported mechanism.

It is called inside the handler factories rather than in each `route.ts`, because
a guarantee that has to be restated in every route file is a guarantee that will
be missing from the next one.

## Why health routes are a limited exception to `defineRoute`

Every other endpoint the application owns is built by `defineRoute`. These two
are not, on four counts:

1. **A different response contract.** `defineRoute` answers `{"data": …}` or
   `{"error": {"code": …}}`; a probe answers a flat document that external tooling
   matches on.
2. **A `503` that is not an error.** The factory maps a closed set of error codes
   onto statuses. Readiness needs a `503` that means "a dependency is absent",
   which is not a failure of the request.
3. **No request pipeline.** A probe is called by a load balancer with no
   credentials. It must not resolve a session, must not authorize, and must not
   run rate limiting, idempotency, cache invalidation, or audit.
4. **Liveness must stay trivial.** Its whole value is that it touches nothing.

The alternative — teaching `defineRoute` about health with a flag — was rejected:
it would put an operational special case inside the boundary every business
endpoint depends on, and every future reader would have to learn that the
envelope has an exception.

So the health platform owns a narrow adapter of its own, `createLivenessHandler`
and `createReadinessHandler`, and **the exception is exactly two files wide**:

- A dependency-cruiser rule refuses any file under `src/app` other than the two
  route files from importing `src/platform/health`.
- An ESLint block over `src/app/api/health/**/route.ts` refuses `@/platform/http`,
  a `try`, a `Response`, and a `.json()`.
- A contract test enumerates the importers and asserts the list.

`defineRoute` itself is unchanged. No health-specific flag was added to it.

## Boundaries

The health platform is one directory with three controlled entry points, split by
**process** rather than by convenience:

| Entry point           | Imported by             | May reach                                            |
| --------------------- | ----------------------- | ---------------------------------------------------- |
| `index.server.ts`     | `pnpm jobs:health`      | the contracts and the logger, nothing else           |
| `liveness.server.ts`  | `GET /api/health/live`  | four constant modules, one serializer, `next/server` |
| `readiness.server.ts` | `GET /api/health/ready` | the above plus database, Redis, storage              |

The split exists because importing `@/platform/database` constructs the Prisma
client at module evaluation. A single shared entry point would mean the liveness
route built a connection pool in order to answer a question that touches nothing
— and it would still return `200`, so nothing would ever reveal it. It would also
mean the worker command loaded Next.js request machinery and an S3 client to ask
about a queue.

A dependency-cruiser **reachability** rule asserts each row transitively, and a
contract test enumerates the exact reachable file set of the liveness route:

```text
src/app/api/health/live/route.ts
src/platform/health/liveness.server.ts
src/platform/health/liveness.ts
src/platform/health/liveness-response.ts
src/platform/health/health-headers.ts
src/platform/health/health-code.ts
src/platform/health/health-status.ts
```

The liveness serializer is a separate module from the readiness one for the same
reason the entry points are separate: a shared serializer would put the readiness
document's types, and the dependency port behind them, into that list. Nothing
there opens a socket today, but the guarantee is a property of the reachable set,
and a guarantee that depends on nobody adding a runtime import to a neighbouring
file is not a guarantee.

### What the platform must not import

Prisma, `pg`, the Redis driver, `ioredis`, BullMQ, the AWS SDK, Better Auth,
`@/platform/auth`, `@/platform/audit`, `@/platform/cache`,
`@/platform/concurrency`, `@/platform/jobs`, `@/worker`, `@/platform/actions`,
`@/platform/http`, `@/platform/proxy`, `@/app`, `@/modules`, `@/ui`, `@/i18n`,
React, `next-intl`, and any Next.js API other than `connection()`.

It owns **no probe of its own**, and that is the design rather than an accident:
whether PostgreSQL is answering can only be asked by the area that owns the
client, and the same is true of Redis, of the object store, and of the queue. The
owning area exports a check; a composition function hands it over. That is also
why each check carries its own failure code — only the owner knows what its own
failure is called.

`@/platform/database` is the single persistence import allowed, and only through
its controlled entry point.

### The registry is immutable

There is no `register()`, no module-level collection, no import-time side effect,
and nothing on `globalThis`. A mutable health registry produces a failure that
never announces itself: the set of checks a probe runs would depend on which
modules happened to have been imported by the time the first request arrived, so
two instances of one deployment could disagree about whether they are ready, and
a probe in a cold serverless invocation could check fewer things than one in a
warm process.

A registry is a **value**, built by a composition function and handed to a
handler. Construction validates that it is non-empty, that no name appears twice,
and that every timeout is bounded. Two processes wanting different checks build
two registries; that is the entire extension mechanism, and it needs no plugin
system.

## Logging and sanitization

Two events, written through one function so the allowlist is applied by
construction:

```text
health.readiness.failed     warn    only when a web probe answers not_ready
health.worker.checked       info|error   once per jobs:health run
```

There is deliberately **no event for a successful readiness probe**. A load
balancer calls that endpoint every few seconds for the lifetime of a deployment;
a line per success would drown everything else, cost money to store, and tell an
operator nothing that the absence of a failure line does not.

The worker command is the opposite case: it is run on purpose and its log line
_is_ its output, so it writes on success too. The level follows the verdict —
`info` when ready, `error` for both failing verdicts.

A line may carry only these fields, and the type that declares them is closed:

```text
process  status  code  databaseStatus  redisStatus  storageStatus  queueStatus  durationMs
```

Never logged: a database URL, a Redis URL, `JOBS_REDIS_URL`, a host, a port, a
queue prefix, a bucket, an endpoint, a credential, a payload, a job name, an
exception message, or a stack trace. There is nowhere in the type to put one, and
anything outside the allowlist is dropped rather than trusted to be harmless.
`console` is not used anywhere in this area.

The latency lives here rather than in the response body: it is useful to an
operator and is infrastructure detail to everybody else.

## Load balancer and orchestrator usage

```text
liveness   GET /api/health/live    → restart on repeated failure
readiness  GET /api/health/ready   → remove from rotation on failure, keep probing
worker     pnpm jobs:health        → exit code; 78 means stop restarting
```

Guidance that follows from the contracts above:

- **Never wire liveness to a dependency and never wire readiness to a restart.**
  The first restarts healthy processes during a database blip; the second kills
  an instance that was about to recover.
- Give readiness an interval comfortably longer than its slowest budget
  (3 000 ms today) so probes cannot queue behind each other.
- Treat `503` as "not now", not as an error to alert on. Alert on it lasting.
- Neither endpoint is authenticated, because a load balancer has no credentials.
  Neither reveals anything about the machine, which is what makes that safe.
- Do not put either endpoint behind a CDN cache. They answer `no-store`; honour
  it.

## Optionality

With every optional dependency off:

```text
REDIS_ENABLED=false
JOBS_ENABLED=false
STORAGE_ENABLED=false
```

- Liveness answers `200`.
- Readiness answers `200` and checks PostgreSQL only, reporting `redis: disabled`
  and `storage: disabled`.
- No Redis client is constructed, no S3 client is constructed, no socket is
  opened, and no name is resolved for either.
- No worker is required and no queue address is needed.
- `pnpm verify` and `pnpm build` both pass.

CI runs the whole default job in exactly that configuration, so a regression that
made the application depend on Redis, a queue, or a bucket fails the build rather
than passing unnoticed.

## Removing an optional dependency

**Removing Redis** — delete `src/platform/redis`, `src/platform/cache`, and
`src/platform/concurrency`, then delete the Redis entry from
`createWebReadinessRegistry` in `web-readiness.server.ts` and the
`REDIS_UNAVAILABLE` code from `health-code.ts`. Liveness is untouched. Readiness
keeps working with two dependencies instead of three; the registry accepts any
non-empty list.

**Removing object storage** — the same shape: delete `src/platform/storage`, then
the storage entry from the registry and the two `STORAGE_*` codes. Nothing else
in this area refers to it.

**Removing background jobs** — delete `src/platform/jobs` and `src/worker`, then
the `jobs:health` script and the `JOBS_REDIS_UNAVAILABLE` and `WORKER_*` codes.
**Nothing in `src/platform/health` needs to change**, because this platform never
imports the jobs area: the worker readiness contract receives its two checks as
arguments, and the worker entry point — which already depends on both areas — is
where they meet.

Web readiness never referred to the queue in the first place, so removing jobs
cannot affect the endpoint a load balancer calls.

## Testing

| Suite                    | What it proves                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit                     | every mapping, the closed sets, containment, timer cleanup, the immutable registry, both handlers                                                          |
| integration (PostgreSQL) | a real `SELECT 1`, read-only under `SET TRANSACTION READ ONLY`, no row changed, failure mapping through an injected probe                                  |
| Redis integration        | enabled and healthy, enabled and unreachable, and disabled costing no client with a real server available                                                  |
| storage integration      | healthy against MinIO, `misconfigured` for a missing bucket and a refused credential, `unavailable` for an unreachable endpoint                            |
| jobs integration         | the queue probe against a real Redis, no socket left behind, and `pnpm jobs:health` exiting `0`, `1`, and `78`                                             |
| contract                 | the two-route inventory, the transitive reachability of each route, the `defineRoute` exception, the closed code set, the ESLint blocks, and this document |
| end-to-end               | both endpoints through a real production build, including the headers and a `200` before any page is visited                                               |

The failure mappings are proved through injected probes and closed ports rather
than by stopping a container. The development and test databases are shared with
every other suite, and a test that stopped one would break everything running
beside it.

## Known limitations

- **A timed-out PostgreSQL query is not cancelled.** The statement keeps running
  on the server; only the probe stops waiting. Cancelling would need a path that
  has to be correct exactly when nothing else is.
- **Readiness reports the moment it was asked.** There is no smoothing, no
  hysteresis, and no consecutive-failure counter — that belongs to the prober,
  which already has one.
- **No dependency is probed more deeply than reachability.** `SELECT 1` does not
  prove a migration is applied, `PING` does not prove a keyspace is intact, and
  `HeadBucket` does not prove an object is readable. Deeper checks cost more,
  fail for reasons a probe cannot act on, and would eventually write something.
- **The worker contract is a command, not an endpoint.** A supervisor that can
  only probe over HTTP cannot use it as-is.
- **`pnpm jobs:health` starts a Node process**, so it costs a second or two of
  startup. It is a deployment-gate and operator tool, not something to run on a
  one-second interval.
- **Backlog depth is not readiness.** A queue with work waiting in it is working,
  so neither contract reports on it. Alerting on backlog is a monitoring
  concern, and this change adds no alerting.
- **No metrics, no Prometheus endpoint, no tracing SDK, and no status page.**
  Deliberately out of scope.

## Related documentation

- [Route Handler Factory](./route-handler-factory.md)
- [Redis Foundation](./redis-foundation.md)
- [Background Jobs and Transactional Outbox](./background-jobs-and-outbox.md)
- [Object Storage and Uploads](./object-storage-and-uploads.md)
- [Observability Foundation](./observability.md)
