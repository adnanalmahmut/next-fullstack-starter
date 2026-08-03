# 2. Server-side error monitoring

- Status: Accepted
- Date: 2026-08-03

## Context

The application now emits traces and metrics over OTLP and structured JSON logs
through Pino. Neither answers the question an on-call engineer actually asks
first: _what broke, where in the code, and how often?_

A trace shows that a request failed and how long it took. A metric shows that the
failure rate rose. Neither carries a stack, neither groups two occurrences of the
same defect together, and neither tells anyone that a failure which used to happen
twice a week now happens every minute. That is what an error-monitoring provider
is for, and it is a genuinely different product from a tracing backend.

Three decisions had to be made together, because the wrong combination of them is
worse than either alone.

**Which provider.** `AGENT_RULES.md` names "Sentry or an equivalent
error-monitoring provider" as part of the mandatory stack. Sentry is the reference
implementation for server-side JavaScript, has a maintained Node SDK, and is what
a generated project is most likely to already have an account for.

**How much of it to adopt.** Since v8 the Sentry Node SDK is built on
OpenTelemetry. Left to its defaults, `Sentry.init()` installs its own span
processor, its own sampler, its own propagator, and its own **context manager**
into the global OpenTelemetry API, and enables automatic instrumentation for HTTP,
database clients, and more. In a process that has already registered its own
providers that is not an addition — it is a replacement.

**Whether the application should depend on the provider at all.** Every other
optional area in this repository is removable by deleting a directory. An
error-monitoring vendor reached directly from five boundaries would not be.

## Decision

**Sentry is the reference server-side error-monitoring adapter, and it reports
unexpected failures and nothing else.**

The three concerns are separated by signal, and each has exactly one owner:

| Signal            | Owner                        | Transport      |
| ----------------- | ---------------------------- | -------------- |
| Traces            | OpenTelemetry SDK            | OTLP/HTTP      |
| Metrics           | OpenTelemetry SDK            | OTLP/HTTP      |
| Logs              | Pino                         | process output |
| Unexpected errors | `ErrorMonitor` port → Sentry | Sentry ingest  |

### Sentry has no tracing in this project

`Sentry.init()` is called with `tracesSampleRate: 0` and
`skipOpenTelemetrySetup: true`, `defaultIntegrations: false`, an empty
`integrations` array, and `registerEsmLoaderHooks: false`. Four reasons, in order
of how much damage each one prevents:

- **It would replace the global OpenTelemetry providers.** The application
  registers its own tracer provider, its own parent-based sampler, its own
  `AsyncLocalStorage` context manager, and the W3C propagator. Sentry's setup
  overwrites all four. The propagator swap alone would change the wire format
  written into the outbox's `traceparent` column, so a request and the job it
  caused would stop being one trace.
- **It would produce duplicate spans.** Every route, action, job, database
  boundary, and storage operation is already traced through one closed contract
  with an attribute allowlist. Sentry's automatic instrumentation would add a
  second, parallel span for the same work — carrying full URLs, query text, and
  connection details, which is exactly what the allowlists exist to prevent.
- **It would be provider lock-in on the one signal that has a standard.** OTLP is
  a specification with many implementations. Application traces should be
  portable to any of them by changing one endpoint.
- **It would install process-wide handlers.** The default integrations register
  `uncaughtException` and `unhandledRejection` handlers, hook the ESM loader, and
  capture console output. A platform module must not decide those for every host
  that imports it, including the test runner.

### The application depends on a port, not on Sentry

`ErrorMonitor` is a four-method port in
`src/platform/observability/error-monitoring/error-monitor.ts`:

```text
capture(error, context)
flush(timeoutMs)
shutdown()
```

Two implementations exist. `NOOP_ERROR_MONITOR` is the default and is what runs
whenever error monitoring is disabled, misconfigured, or failed to start.
`createSentryErrorMonitor` is the one file in the repository that imports
`@sentry/node`, and it imports it _dynamically_, inside the enabled branch — so a
deployment with `ERROR_MONITORING_ENABLED=false` never evaluates the SDK, never
holds a DSN, and never opens a socket.

The port is deliberately tiny. There is no `captureMessage`, no breadcrumb API, no
user-context setter, no transaction API, and no scope object, so "this application
never attaches a user to an error report" is a property of the interface rather
than a rule somebody has to review for.

### Only unexpected failures are sent, and only from one boundary each

Six error codes are ordinary traffic and are never reported: `VALIDATION_FAILED`,
`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, and `RATE_LIMITED`. A
refused request is a working application, and reporting those would bury the
failures that need a human under the ones that need nobody.
`DEPENDENCY_UNAVAILABLE` is deliberately _not_ on that list: it is not a defect,
but it is an operational failure worth a report.

Five boundaries own a failure, and each owns exactly one class of it, so the same
error is never sent twice:

| Boundary         | What it reports                                             |
| ---------------- | ----------------------------------------------------------- |
| `onRequestError` | An error Next.js caught that no adapter had already handled |
| `defineRoute`    | An unexpected failure it turned into a response             |
| `defineAction`   | An unexpected failure it turned into an `ActionResult`      |
| Jobs             | A final or permanent failure — never a transient retry      |
| Outbox loop      | An unexpected failure that threatens the dispatcher         |

### Every event is rebuilt from an allowlist

`sanitizeSentryEvent` constructs a new event from named fields rather than
deleting fields from the one the SDK produced. The direction matters: a deny-list
has to be updated whenever the provider adds a field, and the failure mode of
forgetting is that the new field is sent. An allowlist's failure mode is that a new
field is dropped.

The exception message is replaced by the stable error code. The stack frames are
kept — they are the reason an error-monitoring product is worth having — minus the
local variables and the surrounding source lines. Everything else goes: the
request, the user, the breadcrumbs, the extra bag, the contexts, the host name, and
the module inventory.

## Alternatives

**`@sentry/nextjs` with the setup wizard.** Rejected. It configures client-side
error monitoring, session replay, browser tracing, and a webpack plugin for
source-map upload, and it enables Sentry's OpenTelemetry integration by default —
which is the specific conflict this decision exists to avoid. It also writes
`sentry.client.config.ts` and `instrumentation-client.ts`, and this project ships
no client telemetry.

**Sentry for traces as well, and no OTLP.** Rejected. It is a smaller
dependency footprint and a single vendor, and it makes the application's traces
unportable, its span attributes vendor-shaped, and the trace-context propagation
Sentry's rather than W3C's.

**OpenTelemetry logs for errors, and no error-monitoring provider.** Rejected for
now. The OTLP logs signal would carry the failure, but grouping, regression
detection, release association, and alerting on a new defect are the product, not
the transport. Revisit if a collector-side product covers them.

**No error monitoring at all; rely on the logs.** Rejected. It is the honest
zero-dependency answer and it is also the default this repository ships: with
`ERROR_MONITORING_ENABLED=false` the failures are in the logs and nowhere else.
What the adapter adds is a path for a deployment that wants more, without making
every deployment pay for it.

## Consequences

- One new production dependency, `@sentry/node`, pinned exactly and imported in
  one file.
- Error monitoring is off by default. `pnpm verify`, the production build, the
  end-to-end run, and every integration suite pass with no DSN anywhere, and CI
  never sets one.
- A capture is best effort and is never awaited on a request path. An error
  captured before initialization completes or after shutdown is dropped, which is
  stated rather than hidden: dropping a report is better than making a request
  wait on a vendor.
- A Sentry event cannot be used to debug a payload-shaped problem, because no
  payload is in it. The request id and the trace id are the join to the logs and
  the trace, which do have the operational detail — under this repository's own
  redaction rules.
- Replacing the provider is a change to one file plus the configuration block. The
  port names no vendor type.

## Migration and rollback

There is nothing to migrate: no schema change, no stored data, and no behaviour
change for a deployment that leaves the switch off.

To adopt it, set `ERROR_MONITORING_ENABLED=true` and `SENTRY_DSN`, and optionally
`APP_RELEASE` so events are associated with a release.

To roll back, set `ERROR_MONITORING_ENABLED=false`. The SDK stops being loaded on
the next boot.

To remove it entirely, delete
`src/platform/observability/error-monitoring/sentry-error-monitor.server.ts`,
remove `@sentry/node` from `package.json`, delete the two error-monitoring
variables from the schema and the environment reader, and replace
`captureUnexpectedError` with a no-op — or delete the whole
`error-monitoring` directory and the five call sites. The full procedure is in
[`docs/architecture/observability.md`](../architecture/observability.md).
