# Observability and Production Telemetry

This document defines the implemented observability platform: structured logging
and request correlation, and — layered on top and optional — distributed tracing,
metrics, and server-side error monitoring.

Four contracts live in `src/platform/observability`, and they are deliberately
independent of each other:

| Contract         | Default   | Transport      | Removable by                     |
| ---------------- | --------- | -------------- | -------------------------------- |
| Logging          | always on | process output | nothing; it is the foundation    |
| Tracing          | off       | OTLP/HTTP      | `TELEMETRY_ENABLED=false`        |
| Metrics          | off       | OTLP/HTTP      | `TELEMETRY_ENABLED=false`        |
| Error monitoring | off       | Sentry ingest  | `ERROR_MONITORING_ENABLED=false` |

It does not implement browser telemetry, edge telemetry, OTLP logs, log shipping,
a Prometheus endpoint, dashboards, alert rules, or a collector deployment. Those
are listed under [Known limitations](#known-limitations).

Telemetry is **operational and lossy**. It does not replace the audit platform: an
audit record is a durable business fact written inside a transaction, and a span
is a sample that may be dropped by a sampler, lost by an exporter, or expired by a
retention policy. See
[`application-audit-platform.md`](./application-audit-platform.md).

## Location and dependency boundary

| Area                                              | Responsibility                                              |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `index.server.ts`                                 | The one controlled server-only entry point                  |
| `create-logger.server.ts`                         | Pino construction and base configuration                    |
| `logger.server.ts`                                | Root logger and context-aware child logger access           |
| `log-context.ts`                                  | Framework-independent typed context and status contracts    |
| `request-id.server.ts`                            | Request ID validation and generation                        |
| `request-context.server.ts`                       | `AsyncLocalStorage` request scope                           |
| `operation-timer.server.ts`                       | Monotonic duration measurement                              |
| `safe-error.ts`                                   | Safe error classification                                   |
| `redaction.ts`                                    | The central Pino redaction path list                        |
| `request-error-reporter.server.ts`                | Next.js `onRequestError` adapter                            |
| `register-observability.server.ts`                | What a web server instance does once, before serving        |
| `tracing.server.ts`                               | The generic tracing contract                                |
| `trace-context.ts`                                | W3C `traceparent` / `tracestate` validation                 |
| `trace-log-fields.ts`                             | Log/trace correlation fields                                |
| `database-span.server.ts`                         | The closed database-operation span registry                 |
| `metrics.server.ts`                               | The closed metric registry and its typed recorders          |
| `telemetry/telemetry-config.ts`                   | Lazy, non-throwing telemetry configuration                  |
| `telemetry/telemetry-status.ts`                   | The closed status and process-type sets                     |
| `telemetry/telemetry-log-fields.ts`               | The lifecycle log allowlist                                 |
| `telemetry/telemetry-sdk.server.ts`               | **The only file that touches an OpenTelemetry SDK**         |
| `error-monitoring/error-monitor.ts`               | The provider-neutral port, the no-op, the reportable filter |
| `error-monitoring/error-monitoring-config.ts`     | Lazy, non-throwing error-monitoring configuration           |
| `error-monitoring/sentry-event-policy.ts`         | The event allowlist, pure and testable                      |
| `error-monitoring/sentry-error-monitor.server.ts` | **The only file that touches `@sentry/node`**               |
| `error-monitoring/error-monitor.server.ts`        | The error-monitoring lifecycle                              |

Two areas own the telemetry that describes them, and both are built on the
contracts above rather than on an SDK:

| File                                                                    | Responsibility                 |
| ----------------------------------------------------------------------- | ------------------------------ |
| `src/platform/http/route-telemetry.server.ts`                           | Route span and route metrics   |
| `src/platform/actions/action-telemetry.server.ts`                       | Action span and action metrics |
| `src/platform/jobs/observability/tracing.ts`                            | The two job span names         |
| `src/platform/jobs/outbox/outbox-backlog.server.ts`                     | The bounded backlog query      |
| `src/platform/storage/provider/instrumented-storage-provider.server.ts` | Storage spans and failures     |

Every Node-only file imports `server-only`. Contract tests assert that the
OpenTelemetry SDK appears in exactly one file, that `@sentry/node` appears in
exactly one file, that both are loaded dynamically, and that every other file uses
`@opentelemetry/api` alone.

## Optionality

The default is off, and "off" is stronger than "unused".

With `TELEMETRY_ENABLED=false`:

- No OpenTelemetry SDK module is ever evaluated. The imports in
  `telemetry-sdk.server.ts` are `await import(...)` expressions inside the enabled
  branch, so there is no exporter object, no batch queue, no export timer, no
  metric-reader interval, no DNS lookup, and no socket.
- No tracer provider, meter provider, context manager, or propagator is
  registered. `@opentelemetry/api` stays a no-op facade, so every `withActiveSpan`
  runs the operation and returns its value, and every metric recorder does nothing.
- `pnpm verify`, `next build`, `pnpm test:e2e`, and every other integration suite
  pass with no endpoint, no credential, and no collector anywhere.

With `ERROR_MONITORING_ENABLED=false`:

- `@sentry/node` is never evaluated, no client is constructed, no DSN is held in
  memory, no flush timer exists, and nothing is sent.
- `captureUnexpectedError` reaches `NOOP_ERROR_MONITOR` and returns.

There is **no localhost fallback anywhere in production code**. The OTLP exporters
default to `localhost:4318` when constructed without a URL; this application always
passes an explicit URL derived from the configured endpoint, so a missing endpoint
is a named configuration mistake rather than a silent export to a loopback port
nobody is listening on.

### An invalid configuration degrades; it never fails a process

Every other configuration in this repository refuses to start when it is
malformed, which is right for a database URL. Telemetry is the opposite. A mistyped
endpoint, a credential embedded in the URL, an unparseable header list, or an
out-of-range number resolves to a **disabled** configuration carrying the stable
status `invalid-configuration`. One sanitized line is logged, once, and the process
keeps serving with the no-op API. The same holds for a failure to bring up the SDK
(`start-failed`) and for the error monitor.

Nothing about the failure is reported beyond the status code. The values in scope
at that moment are an OTLP endpoint and a header credential, and an SDK error
message is exactly where both would appear.

## Environment variables

Both blocks are read **lazily** and never at import time, and neither is part of
`serverEnvironmentSchema`: a project that never enables them never validates them.

The disabled path reads **only the switch**. That is not an optimization —
`TELEMETRY_OTLP_HEADERS` and `SENTRY_DSN` are credentials, and a disabled
application has no business holding one in memory, printing it in a validation
error, or failing to boot because an operator left a malformed one behind. Unit
tests pass a recording source and assert the sensitive names were never read.

### Telemetry

| Variable                              | Required when            | Default                      |
| ------------------------------------- | ------------------------ | ---------------------------- |
| `TELEMETRY_ENABLED`                   | never                    | `false`                      |
| `TELEMETRY_OTLP_ENDPOINT`             | `TELEMETRY_ENABLED=true` | none — no localhost fallback |
| `TELEMETRY_OTLP_HEADERS`              | never                    | none                         |
| `TELEMETRY_TRACE_SAMPLE_RATIO`        | never                    | `1`, or `0.1` in production  |
| `TELEMETRY_METRIC_EXPORT_INTERVAL_MS` | never                    | `60000` (1 000 – 300 000)    |
| `TELEMETRY_EXPORT_TIMEOUT_MS`         | never                    | `10000` (500 – 60 000)       |
| `APP_RELEASE`                         | never                    | none                         |

- **`TELEMETRY_OTLP_ENDPOINT`** accepts `http:` or `https:` only, is bounded at
  2 048 characters, and is refused outright if it embeds a username or a password
  — a credential inside a URL travels through every place a URL may appear, and
  none of those apply the redaction a header does. The signal paths `/v1/traces`
  and `/v1/metrics` are appended by the application. It is never logged, never
  placed on a span or a metric, and never returned in an error response.
- **`TELEMETRY_OTLP_HEADERS`** is a comma-separated list of `name=value` pairs and
  is treated as a secret throughout. The parser is deliberately narrower than the
  W3C `baggage` form: no quoting, no escaping, no percent-decoding, no metadata.
  CR and LF are refused anywhere in the value, because a newline in a header value
  is header injection. At most 8 pairs, a 64-character name, a 512-character
  value, and a 2 048-character list. It is never logged or serialized, and a
  refusal names the shape rather than the value.
- **`TELEMETRY_EXPORT_TIMEOUT_MS`** must not exceed
  `TELEMETRY_METRIC_EXPORT_INTERVAL_MS`: an export allowed to outlive the gap
  before the next collection would still be running when it began, and the SDK
  refuses the combination when the reader is constructed.
- **`APP_RELEASE`** is bounded to 64 characters and a closed character set. It is
  never derived by running `git` at runtime — a production process must not shell
  out, and a container has no repository to ask — and its absence is not a failure.

### Error monitoring

| Variable                   | Required when                   | Default |
| -------------------------- | ------------------------------- | ------- |
| `ERROR_MONITORING_ENABLED` | never                           | `false` |
| `SENTRY_DSN`               | `ERROR_MONITORING_ENABLED=true` | none    |
| `APP_RELEASE`              | never                           | none    |

`SENTRY_DSN` is validated structurally — scheme, public key, project path, and no
password — bounded to 512 characters, and is never logged, never echoed in a
validation error, and never reported by a health or telemetry endpoint.

The two blocks are independent by design and share no helper: traces and metrics
go to a collector, unexpected failures go to a vendor, and neither decision may
switch the other off. `APP_RELEASE` appears in both readers for the same reason —
either area can be deleted without editing the other's configuration.

## The OpenTelemetry SDK

### Why it is assembled by hand

`@opentelemetry/sdk-node` would be one dependency instead of eight, and it is
deliberately not used: it depends on the Prometheus exporter, the Zipkin exporter,
three gRPC exporters, three protobuf exporters, the Jaeger propagator, and the
OTLP logs SDK. This application exports traces and metrics over **one** transport
and installs **no** automatic instrumentation, so a package carrying five
transports it will never use is a supply-chain cost with no benefit.

The installed set, all pinned exactly:

```text
@opentelemetry/api                        1.9.1   (already present)
@opentelemetry/sdk-trace                  2.10.0
@opentelemetry/sdk-metrics                2.10.0
@opentelemetry/resources                  2.10.0
@opentelemetry/core                       2.10.0
@opentelemetry/context-async-hooks        2.10.0
@opentelemetry/semantic-conventions       1.43.0
@opentelemetry/exporter-trace-otlp-http   0.221.0
@opentelemetry/exporter-metrics-otlp-http 0.221.0
@sentry/node                              10.69.0
```

`@opentelemetry/sdk-trace` rather than `@opentelemetry/sdk-trace-base`: the latter
is now a compatibility shim that re-exports the former, and its `BasicTracerProvider`
is the deprecated name for `TracerProvider`.

A contract test refuses `@opentelemetry/sdk-node`, the auto-instrumentation
packages, `@prisma/instrumentation`, the gRPC and protobuf exporters, the OTLP logs
SDK, the Prometheus, Jaeger, and Zipkin exporters, every browser package,
`@vercel/otel`, and the two deprecated `sdk-trace-*` packages.

### No automatic instrumentation

None is registered, and that is a decision rather than an omission. Automatic HTTP
and Prisma instrumentation produce spans nobody wrote, carrying full URLs, query
text, bind parameters, and connection details — the opposite of the attribute
allowlists every span in this application passes through. Every span here is
created explicitly, at a boundary this repository owns.

### Lifecycle

```text
startProductionTelemetry({ processType })   → ProductionTelemetryHandle
forceFlushProductionTelemetry()             → bounded, best effort
shutdownProductionTelemetry()               → bounded, idempotent
productionTelemetryStatus()                 → TelemetryStatus
resetProductionTelemetry()                  → teardown bookkeeping
```

`processType` is a closed set: `web` or `worker`.

| Status                  | Meaning                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `disabled`              | The switch is off. Nothing was imported and nothing built.   |
| `invalid-configuration` | Asked for, but the configuration cannot produce an exporter. |
| `started`               | Providers registered and exporting.                          |
| `start-failed`          | Valid configuration, SDK could not be brought up.            |
| `stopped`               | Every provider, reader, timer, and exporter released.        |

Guarantees:

- **Idempotent.** Concurrent callers share one initialization promise, stored
  before the first `await`, so a second call joins the first rather than
  registering a second provider over the top of it.
- **Retryable after a failure.** A failed start clears the shared promise, so one
  transient failure is not permanent for the life of the process — and the failure
  path stays testable.
- **Never throws.** Every path resolves to a status.
- **Bounded shutdown and flush.** Both are capped at
  `TELEMETRY_SHUTDOWN_TIMEOUT_MS` (5 s) and swallow their failures, so a collector
  that has gone away cannot hold a container open or change the exit code of a
  process whose work succeeded.
- **Never shuts down twice.** A second call joins the first.
- **Releases everything.** The tracer provider owns the batch processor's timer and
  the meter provider owns the periodic reader's interval; both are shut down, the
  API globals are released first, and the cached metric instruments are dropped.
- **No process-wide signal handler.** A platform module installs none. The worker
  entry point owns its signals, its exit code, and its flush.

### Sampling

```text
ParentBasedSampler({ root: TraceIdRatioBasedSampler(ratio) })
```

The parent decision wins whenever there is a parent, which is what makes a
request, the outbox row it wrote, and the job that row produced either all sampled
or all dropped — a half-sampled trace is worse than none, because it looks like a
broken system. A root span falls back to the ratio applied to the **trace id**, so
the decision is deterministic and needs no coordination between processes.

Nothing about the caller enters the decision: not a user id, not a route, not a
header, not a payload. A sampler that can be steered by input is a sampler an
attacker can use to hide.

The default is 1 outside production and 0.1 in production. The parent decision is
carried through the outbox's `traceparent` flags byte and respected by the worker.

### Resource metadata

Exactly four attributes, built with `resourceFromAttributes` — no automatic
resource detection runs:

```text
service.name                  always: next-fullstack-starter
service.version               only when APP_RELEASE is set
deployment.environment.name   the validated APP_ENV
app.process.type              web | worker
```

Deliberately absent: `host.name`, IP addresses, `process.pid`, user name, cloud
account, region, container id, Kubernetes pod, and machine architecture. Each of
those is either an identifier or a piece of infrastructure topology, and all of
them would travel to a third party on every single span.

## Web versus worker registration

**Web.** `src/instrumentation.ts` stays small and dynamically imports the Node-only
implementation only when `NEXT_RUNTIME` is `nodejs`, so nothing server-only can
enter an Edge bundle. `register()` is awaited by Next.js before the first request
is served, which is the only moment providers can be installed without the first
request being silently untraced. It logs `application.started` at most once, then
starts telemetry, then the error monitor. Neither can prevent startup.

**Worker.** `src/worker/jobs.worker.ts` starts telemetry and the error monitor for
`processType: "worker"` _before_ the first job is consumed, and on shutdown — after
the worker has drained and before Prisma disconnects — force-flushes telemetry,
flushes and closes the error monitor, and shuts telemetry down. Every one of those
is bounded and swallows its failures, so an exporter that cannot reach its
collector cannot change an exit code that has already been decided.

**Edge.** Nothing. There is no edge telemetry and no client telemetry, and no
`instrumentation-client.ts` or `sentry.*.config.ts` file exists.

## Span catalog

Every span is created through `withActiveSpan` in `tracing.server.ts` and carries
`app.outcome` (`succeeded` | `failed` | `replayed`) plus `app.error.code` when a
stable code exists.

| Span name                 | Created by                  | Additional attributes                                                                                |
| ------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `route.<definition.name>` | `defineRoute`               | `app.operation.name`, `app.operation.type=route`, `http.request.method`, `http.response.status_code` |
| `server_action.<name>`    | `defineAction`              | `app.operation.name`, `app.operation.type=server_action`                                             |
| `db.<operation>`          | `withDatabaseOperationSpan` | `db.operation.name`                                                                                  |
| `storage.<operation>`     | the instrumented provider   | `storage.operation`, `storage.outcome`, `storage.failure.code`                                       |
| `jobs.outbox.publish`     | the outbox dispatcher       | `jobs.jobName`, `jobs.jobVersion`, `jobs.outboxId`, `jobs.attempt`                                   |
| `jobs.execute`            | the job processor           | `jobs.jobName`, `jobs.jobVersion`, `jobs.outboxId`, `jobs.attempt`                                   |

The closed database-operation registry:

```text
audit.append                  audit.list
outbox.write                  outbox.claim
outbox.mark_published         outbox.reschedule
outbox.dead_letter            outbox.backlog
jobs.execution_receipt
storage.upload_intent.create  storage.finalize.claim
storage.finalize.commit       storage.cleanup.claim
```

The closed storage-operation registry:

```text
storage.presign_upload   storage.head      storage.stream
storage.copy             storage.delete    storage.presign_download
```

`checkBucket` is deliberately **not** instrumented. A health probe runs on a load
balancer's schedule, so it is the highest-frequency caller of the provider in any
deployment and the one whose failures are least interesting; instrumenting it would
make `app.storage.failures` a graph of probe noise rather than of uploads that did
not work. The liveness probe is not instrumented either.

### Route and action span coverage

The route span covers the **whole** lifecycle — the rate limit, validation, actor
resolution, authorization, the idempotency decision, the use case, the idempotency
completion, `afterSuccess`, cache invalidation, `audit`, and serialization — because
that is what the caller waited for. The execution order is unchanged: the span
wraps the existing body and the body reports its outcome back.

## Metric catalog

Durations are recorded in **seconds**, as the OpenTelemetry conventions require,
even though every duration in this codebase is measured in milliseconds. The
conversion happens in one place per recorder.

| Metric                       | Kind      | Unit | Attributes                                                                  |
| ---------------------------- | --------- | ---- | --------------------------------------------------------------------------- |
| `app.route.requests`         | counter   | `1`  | `route.name`, `http.request.method`, `http.response.status_code`, `outcome` |
| `app.route.duration`         | histogram | `s`  | the same four                                                               |
| `app.action.executions`      | counter   | `1`  | `action.name`, `outcome`, `error_code` when failed                          |
| `app.action.duration`        | histogram | `s`  | `action.name`, `outcome`                                                    |
| `app.jobs.executions`        | counter   | `1`  | `job.name`, `job.version`, `job.outcome`                                    |
| `app.jobs.duration`          | histogram | `s`  | `job.name`, `job.version`, `job.outcome`                                    |
| `app.jobs.retries`           | counter   | `1`  | `job.name`, `job.version`                                                   |
| `app.jobs.dead_lettered`     | counter   | `1`  | `job.name`, `job.version`                                                   |
| `app.outbox.publish`         | counter   | `1`  | `job.name`, `job.version`, `job.outcome`                                    |
| `app.outbox.publish_retries` | counter   | `1`  | `job.name`, `job.version`                                                   |
| `app.outbox.dead_lettered`   | counter   | `1`  | `job.name`, `job.version`                                                   |
| `app.outbox.backlog`         | gauge     | `1`  | `state` ∈ `pending` \| `due` \| `leased` \| `dead_lettered`                 |
| `app.storage.failures`       | counter   | `1`  | `operation`, `failure_code`                                                 |

An error rate is derived from `outcome` rather than counted separately, and every
instrument is created once per process — an instrument is a handle on aggregation
state, so one per request would allocate on every request and make the SDK warn
about a duplicate.

`job.name` and `job.version` are acceptable dimensions precisely because the job
registry is closed and small: the number of time series is a property of the code
rather than of traffic. An outbox row whose job cannot be resolved — written by a
newer release, or by one whose definition has since been removed — is counted under
one shared `unresolved` identity rather than letting the dimension grow.

### Outbox backlog gauges

Observable, worker-only, and bounded:

- Registered by `startJobsWorkerRuntime` and cancelled first during shutdown, so no
  collection cycle can begin against a database connection that is about to close.
- Nothing is registered when `JOBS_ENABLED` is false.
- PostgreSQL is the source. No Redis connection is opened and no queue is consulted.
- The aggregate runs over a bounded sample (`MAX_OUTBOX_BACKLOG_SAMPLE`, 10 000) of
  rows that are actually interesting — unpublished or dead-lettered — so published
  history is never scanned. Past that depth the exact number has stopped being the
  signal: "more than ten thousand pending" and "eleven thousand pending" call for
  the same action.
- One in-flight collection at a time. A cycle that begins while the previous one is
  still running is dropped, so a slow database cannot stack collections.
- Each cycle is capped at `MAX_METRIC_OBSERVER_BUDGET_MS` (10 s). A failure or a
  timeout is a missing sample, never a failed worker.
- The backlog is **not** a readiness condition. A deep backlog means the worker has
  work to do, not that the deployment is unhealthy, and a probe that failed on it
  would take instances out of service exactly when they were needed.

## Attribute allowlists: what may never appear

The same discipline as the log-field allowlists, applied to data that leaves the
deployment. Never on a span, a metric, or an error report:

- A request or response body, a form field, a job payload, a job result, or any
  use-case output.
- A full URL, a query string, a path parameter value, or a dynamic path.
- A header collection, an `Authorization` header, or a cookie.
- An actor, a user id, an email address, a display name, a role, or a session id.
- An idempotency key, a correlation id or causation id as a _metric dimension_, or
  a request id as a metric dimension (it is unique per request, so it would create
  one time series per request).
- SQL, a query, bind parameters, a table name, a row value, a record id, a
  connection string, a database host, or a schema name.
- A bucket, an endpoint, a region, an object key, an original filename, a content
  type, an extension, a checksum, a signed URL, an access key, an object id, or an
  upload-intent id.
- A queue key, a Redis address, a raw error message, or a stack trace.

`recordException` is **never** called. It copies `error.message` and `error.stack`
onto the span, which is the single most reliable way for a payload to reach a third
party. A failed span carries a status _code_ and, when one exists, a stable error
code — never a status message.

## Request → outbox → job propagation

```text
route.<name>  or  server_action.<name>       (the request's span)
        ↓ business transaction commits
outbox_message.traceparent / .tracestate     (W3C, validated, bounded)
        ↓ the dispatcher restores the stored parent
jobs.outbox.publish                          (a child of the request's span)
        ↓ the publish span's own context is injected
BullMQ envelope.traceContext
        ↓ the worker restores the remote parent
jobs.execute                                 (a child of the publish span)
```

Every hop is a real parent/child edge, not a shared correlation id, and every span
belongs to the trace the request started. A jobs integration test asserts exactly
that against real PostgreSQL and real Redis.

Details that matter:

- The envelope carries the **publish span's** context, not the request's, and it is
  therefore built _inside_ the publish span. Injecting the request's context would
  make the execute span a second child of the request rather than a child of the
  publish, and the middle hop would disappear from the trace.
- `traceparent` and `tracestate` are validated by `sanitizeTraceContext` before
  they are stored and again when they are read back — an unvalidated header would
  be an unbounded string in a durable column, and the row may have been written by
  an older release.
- Malformed context is **dropped, never rejected**. The publish and the execution
  run as roots. A job that refused to run because a header was mangled would make
  observability a correctness dependency, which is exactly backwards.
- Baggage is never propagated, never stored, and never extracted. It is an open
  key/value bag and is the propagation field most likely to be carrying a user
  identifier.
- Propagation uses the official `propagation.inject` and `propagation.extract`
  APIs. Nothing parses or formats a header by hand.
- No migration was added and no column changed: the existing `traceparent` and
  `tracestate` columns are reused, and at-least-once delivery, the BullMQ job id,
  and every idempotency guarantee are untouched.

## Log and trace correlation

When a valid span is active, three optional fields are added to the structured log
bindings:

```text
traceId    spanId    traceFlags
```

They are read from the active span and from nowhere else, so a caller cannot choose
the trace its log line claims to belong to. The assembled `traceparent`,
`tracestate`, and baggage are all deliberately absent — a log line carries
identifiers, not a propagation wire format.

With no SDK registered the bindings are byte for byte what they were before tracing
existed, which is what keeps every existing log assertion valid. A failure to read
a span context can never stop a line being logged.

## Error monitoring

The decision, the alternatives, and the reasoning are in
[ADR 2](../adr/0002-server-error-monitoring.md). In summary:

- Sentry reports **unexpected failures only**. Traces and metrics belong to
  OpenTelemetry over OTLP; logs belong to Pino.
- `tracesSampleRate: 0` and `skipOpenTelemetrySetup: true`, so Sentry never
  replaces the global OpenTelemetry providers and never produces a duplicate span.
- `defaultIntegrations: false` and `integrations: []`, so there is no automatic
  instrumentation, no console breadcrumb, no request-data capture, no
  local-variable capture, no module inventory, and no process-wide handler.
- No session replay, no profiling, no browser SDK, no edge SDK.
- Six error codes are never sent: `VALIDATION_FAILED`, `UNAUTHENTICATED`,
  `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`. `DEPENDENCY_UNAVAILABLE`
  **is** sent — it is not a defect, but it is an operational failure.
- Five boundaries, each owning one class of failure, so the same error is never
  reported twice: `onRequestError`, `defineRoute`, `defineAction`, a job's final or
  permanent failure, and an unexpected failure in the outbox dispatcher loop. A
  transient job retry is never reported.
- Every event is rebuilt from an allowlist by `sanitizeSentryEvent`, which
  constructs a new event rather than deleting fields — a deny-list's failure mode
  is that a newly added provider field is sent, an allowlist's is that it is
  dropped. The exception message is replaced by the stable error code; the stack
  frames are kept, minus local variables and source context.
- The tags an event may carry: `boundary`, `process_type`, `operation_name`,
  `error_code`, `request_id`, `trace_id`, `job_name`, `job_version`. Nothing else
  survives.
- A capture is synchronous, best effort, and never awaited on a request path. An
  error captured before initialization completes or after shutdown is dropped,
  which is stated rather than hidden: dropping a report is better than making a
  request wait on a vendor.

## Failure containment

Telemetry never changes what the application does. The following are each covered
by an explicit test:

| Failure                                   | Guaranteed outcome                                      |
| ----------------------------------------- | ------------------------------------------------------- |
| Tracer provider throws                    | The operation runs and returns its value                |
| Span creation throws                      | The operation runs and returns its value                |
| Context activation throws                 | The operation runs **exactly once**, without a span     |
| `setAttribute` / `setStatus` throws       | Contained; the outcome is unchanged                     |
| `span.end` throws                         | Contained; a lost span, not a lost operation            |
| Meter provider throws                     | Contained                                               |
| Counter `add` / histogram `record` throws | Contained                                               |
| Observable gauge callback throws          | A missing sample; the worker is unaffected              |
| Trace or metric exporter fails            | The operation's result is unchanged; the flush resolves |
| OTLP endpoint unreachable                 | Start succeeds, work proceeds, shutdown completes       |
| Sentry init / capture / flush fails       | Contained; no second failure                            |

The subtle one is context activation. `context.with` can fail because the context
implementation is broken _or_ because the operation itself threw, and the two must
be told apart: the first is recovered from by running without a span, the second
must never be "recovered" from because the operation already ran. An `entered` flag
set as the first statement inside the operation distinguishes them exactly, so a
mutation is never repeated.

Everything else follows from that: a business error always propagates unchanged, a
span is always ended in `finally`, and a metric is recorded exactly once per wrapped
call — from the outcome the body reported, in `finally`, rather than at each of the
adapter's several exits.

## Local testing

```bash
# The default suites need no collector, no vendor, and no credential.
pnpm verify

# The only suite with telemetry enabled. It starts an ephemeral OTLP receiver on a
# loopback port inside the test process and closes it in `finally`; there is nothing
# to provision and no port left listening.
pnpm test:telemetry:integration

# The request → outbox → job trace chain, against real PostgreSQL and Redis.
pnpm redis:up
pnpm test:jobs:integration

# Storage spans and the failure counter, against real MinIO.
pnpm storage:up
pnpm test:storage:integration
```

The telemetry suite uses the **real** OTLP exporters rather than an in-memory one,
because an in-memory exporter proves that spans were produced while only a receiver
proves that they were serialized, batched, addressed, authenticated, and sent — and
because it lets a test assert that the OTLP credential travels as a request header
and appears nowhere in the payload. In-memory exporters are used where parent/child
assertions are the point, which is the jobs and storage suites.

To try it against a real collector, run one on `127.0.0.1:4318` and set
`TELEMETRY_ENABLED=true` with `TELEMETRY_OTLP_ENDPOINT=http://127.0.0.1:4318` in
`.env.local`. No collector is deployed or committed by this repository.

## CI testing

The `Verify` job runs with `TELEMETRY_ENABLED=false` and
`ERROR_MONITORING_ENABLED=false`, and `TELEMETRY_OTLP_ENDPOINT`,
`TELEMETRY_OTLP_HEADERS`, and `SENTRY_DSN` are absent from the job's environment
entirely. That is what makes `Verify project`, the production build, and the
end-to-end run prove the optionality contract rather than assume it.

One step enables telemetry: `Run telemetry integration tests`. It needs no service
and adds no secret — the receiver is started inside the test process on an
ephemeral port. No step ever enables error monitoring: a DSN is a credential
belonging to a vendor account, and the Sentry adapter is exercised in the unit suite
against an unreachable loopback DSN, which proves the lifecycle without sending
anything anywhere.

## Deployment responsibilities

This repository produces telemetry. It deploys nothing that receives it.

The deployment platform owns:

- Running or subscribing to an OTLP/HTTP endpoint, and its authentication.
- Retention, indexing, access control, sampling beyond the application's own ratio,
  and cost.
- Dashboards and alert rules. None are committed here.
- Log collection: production emits JSON to the process output stream, as before.
- Source-map upload, if readable stack traces from a minified build are wanted.
  Nothing here uploads one.
- The Sentry project, its DSN, and its retention.

## Removal procedure

Telemetry and error monitoring are removable independently, and neither removal
touches business code.

**To remove telemetry (traces and metrics):**

1. Delete `src/platform/observability/telemetry/`,
   `src/platform/observability/metrics.server.ts`,
   `src/platform/observability/tracing.server.ts`,
   `src/platform/observability/trace-log-fields.ts`, and
   `src/platform/observability/database-span.server.ts`.
2. Delete `src/platform/http/route-telemetry.server.ts`,
   `src/platform/actions/action-telemetry.server.ts`,
   `src/platform/storage/provider/instrumented-storage-provider.server.ts`,
   `src/platform/jobs/observability/tracing.ts`, and
   `src/platform/jobs/outbox/outbox-backlog.server.ts`, and remove their call sites
   — one wrapper in `defineRoute`, one in `defineAction`, one decorator application
   in `storage-client.server.ts`, the `withJobSpan` and `withDatabaseOperationSpan`
   calls, and the backlog registration in the worker runtime.
3. Remove the telemetry exports from `src/platform/observability/index.server.ts`
   and the re-exports from `src/platform/jobs/index.server.ts`.
4. Remove the eight `@opentelemetry/*` SDK packages from `package.json` and update
   the lockfile. Keep `@opentelemetry/api` only if the trace-context validators are
   still wanted.
5. Delete `telemetryEnvironmentSchema` and its constants from
   `src/config/env/schema.ts`, delete `src/config/env/read-telemetry.ts` and
   `src/config/env/otlp-headers.ts`, and remove the telemetry block from
   `.env.example`.
6. Delete `vitest.telemetry.config.ts`, `tests/telemetry/`,
   `tests/fixtures/otlp-receiver.fixture.ts`, the `test:telemetry:integration`
   script, and the CI step and environment entries.
7. Delete `tests/jobs/trace-propagation.jobs.test.ts`,
   `tests/storage/telemetry.storage.test.ts`, the telemetry contract suite, and the
   telemetry unit tests.
8. Remove the telemetry sections of this document.

**To remove error monitoring:** delete
`src/platform/observability/error-monitoring/`, remove its exports from
`index.server.ts`, remove the five `captureUnexpectedError` call sites, remove
`@sentry/node`, delete `errorMonitoringEnvironmentSchema` and
`src/config/env/read-error-monitoring.ts`, remove the block from `.env.example` and
the entry from CI, and delete ADR 2 along with the error-monitoring tests.

**What removal must not touch.** Pino logging, request IDs, the request context,
operation timers, safe error classification, redaction, the jobs platform, the
outbox and its data — including the existing `traceparent` and `tracestate` columns
— the audit platform, and the health platform. None of them depends on telemetry:
contract tests assert that the health platform imports no part of it and that the
liveness route's import graph is unchanged.

## Known limitations

- **No browser telemetry.** No real-user monitoring, no Web Vitals provider, no
  session replay, and no client SDK of any kind.
- **No edge telemetry.** The Edge runtime registers nothing.
- **No OTLP logs.** Logs are JSON on the process output stream, and shipping them
  is the platform's job.
- **No dashboards, no alert rules, and no collector deployment.** This repository
  produces signals; consuming them is a deployment decision.
- **No automatic source-map upload.** A minified production build produces stack
  frames that need a source map the deployment must upload itself.
- **No automatic instrumentation.** Nothing outside the boundaries listed in the
  span catalog is traced — no HTTP client call, no Prisma query, no Redis command.
  An interesting operation gets a span when somebody adds one.
- **Metrics are not exactly-once.** A counter increment is recorded in memory and
  exported on an interval; a process that dies between the two loses the sample.
  Every metric here is a rate or a level, and neither is a ledger.
- **Telemetry is lossy and is not an audit trail.** A span may be sampled away,
  dropped by an exporter, or expired by a retention policy. Anything that must
  survive belongs in the audit platform, in a database transaction.
- **The trace chain needs an SDK on both sides.** With telemetry disabled the
  outbox stores no `traceparent`, so a request and its job are joined by the
  correlation id in the logs rather than by a trace.

## Structured logging

Everything below predates production telemetry and is unchanged by it.

### Pino and structured JSON

One Pino root logger with these stable base fields:

```text
service=next-fullstack-starter
environment=<validated APP_ENV>
```

All environments emit the same JSON format. There is no human-formatted logger,
`pino-pretty`, remote transport, or logging provider.

The default level policy:

| Environment   | Minimum level |
| ------------- | ------------- |
| `development` | `debug`       |
| `test`        | `silent`      |
| `staging`     | `info`        |
| `production`  | `info`        |

Tests that inspect logs inject an in-memory destination and an explicit level.
`LOG_LEVEL` is intentionally not an environment setting.

Every meaningful record uses a stable event name as the Pino message and puts
searchable dimensions in typed fields. Event messages must not contain arbitrary
user input or prose that changes the query contract.

### Typed context and child loggers

`LogContext` is closed to explicit optional fields:

```text
requestId  jobId  userId  actorType  organizationId
module  operation  route  method  routerKind  locale
durationMs  status  errorCode
traceId  spanId  traceFlags
```

`status` is one of `started`, `succeeded`, or `failed`. The last three are the
trace-correlation fields described above and are present only when a valid span is
active.

Pino child loggers inherit their parent's bindings, destination, level, and
redaction configuration without mutating the root or sibling loggers.
`getRequestLogger` adds the current request scope when one exists and returns a
root-derived logger when it does not. It never creates persistent global request
state.

### Request ID contract

The stable header is `x-request-id`.

Only an RFC 4122 UUID v4 string in its bounded canonical form is trusted as an
incoming correlation value. A missing, empty, malformed, oversized, or non-string
value is replaced with `crypto.randomUUID()`. A request ID is only a correlation
identifier; it is not identity, authentication, authorization, or proof of origin.

For paths handled by the proxy, the request-ID step of the pipeline in
`src/platform/proxy`:

1. validates or creates the ID;
2. places it on the request headers before `next-intl` creates its response, so
   Next.js can forward it to downstream server handling;
3. places the same ID on the outgoing response.

The proxy matcher, the pipeline order, and the locale-cookie policy are documented
in [`proxy-request-pipeline.md`](./proxy-request-pipeline.md).

### Request context lifecycle

`RequestContext` requires `requestId` and may carry other currently known typed
fields. The server API provides:

```text
runWithRequestContext   getRequestContext   requireRequestContext
```

`runWithRequestContext` uses `AsyncLocalStorage.run()`. The context follows awaited
promises, remains isolated between concurrent and nested scopes, preserves callback
return values, rethrows callback errors unchanged, and is unavailable after the
callback completes or fails. `getRequestContext` returns `undefined` outside a
scope; `requireRequestContext` throws a predictable diagnostic error. No plain
mutable global or `enterWith()` is used for request state.

### Operation timing and events

`startOperationTimer` uses Node's monotonic performance clock and reports finite,
non-negative milliseconds at consistent microsecond precision. It does not wrap
operations, choose levels, or catch failures.

The shared event identifiers are:

```text
application.started        request.failed
operation.started          operation.succeeded        operation.failed
job.started                job.succeeded              job.failed
```

The telemetry lifecycle adds its own, each carrying only `processType`, `status`,
and — for a shutdown — `durationMs`:

```text
telemetry.started            telemetry.start_failed            telemetry.stopped
error_monitoring.started     error_monitoring.start_failed     error_monitoring.stopped
```

The route, action, cache, concurrency, jobs, audit, storage, and health areas each
own their own event names and field allowlists, documented alongside them.

### Error logging policy

`toSafeLogError` recognizes `ApplicationError` by its internal class identity and
preserves only its stable `ErrorCode`. Unknown `Error` instances and non-Error
thrown values become `INTERNAL_ERROR` with a closed `errorType`.

The safe representation contains only `errorType` and `errorCode`. It excludes
message, stack, cause, class name, arbitrary properties, Prisma metadata, SQL,
provider payloads, headers, cookies, and tokens. Expected validation,
unauthenticated, forbidden, not-found, and conflict errors are reported at `warn`;
unexpected and internal failures at `error`. Logging failure while reporting a
request error is contained so it does not replace the original application
behaviour.

The Pino serializers for fields named `err` and `error` also apply the safe
classifier as defense in depth. Callers must still never attach raw errors.

### Redaction and prohibited data

Pino removes centrally configured common casing and nested forms of:

```text
password  currentPassword  newPassword  confirmPassword  passwordHash
token  accessToken  refreshToken  idToken  sessionToken
apiKey  secret  clientSecret
authorization  cookie  cookies
request  req  session
```

Redaction paths are application-controlled and cannot be supplied by user input.
Redaction is only defense in depth. Production code must never log raw request or
response objects, bodies, header collections, cookies, sessions, environment
objects, database records, Prisma or SQL errors, provider payloads, authentication
tokens, payment data, or arbitrary personal data.

Production source uses the structured logger. ESLint rejects `console.*` in `src`
production files; tests and build tooling remain narrowly outside that rule.

### Correct usage

```ts
await runWithRequestContext({ requestId }, async () => {
  const logger = getRequestLogger({
    module: "catalog",
    operation: "product.list",
  });

  logger.info({ status: "started" }, "operation.started");
});
```

```ts
const timer = startOperationTimer();
const result = await operation();

getRequestLogger({ module: "catalog", operation: "product.list" }).info(
  { status: "succeeded", durationMs: timer.elapsedMs() },
  "operation.succeeded",
);
```

Tracing a boundary the platform does not already cover:

```ts
import {
  DATABASE_OPERATION,
  withDatabaseOperationSpan,
} from "@/platform/observability/index.server";

await withDatabaseOperationSpan(DATABASE_OPERATION.AUDIT_APPEND, () =>
  client.auditRecord.create({ data, select: { id: true } }),
);
```

### Prohibited usage

```ts
logger.info({ headers: request.headers }, "request.received");
logger.info({ body }, "request.received");
logger.error({ error }, "request.failed");
console.log("request started");

span.recordException(error); // never: it copies the message and the stack
span.setStatus({ code: SpanStatusCode.ERROR, message: error.message }); // never
counter.add(1, { userId, objectKey }); // never: unbounded, and personal
```

Do not place user-facing or localized text in event names, span names, metric
names, or attribute values.
