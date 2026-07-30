# Observability Foundation

This document defines the implemented request-correlation and structured
logging foundation. Its goals are predictable JSON records, safe correlation
across asynchronous server work, stable event identifiers, and defense in depth
against sensitive-data leakage.

It does not implement authentication, authorization, audit persistence,
distributed tracing, metrics, remote log shipping, or business-specific
logging.

## Location and dependency boundary

The implementation lives in `src/platform/observability`.

| Area                               | Responsibility                                           |
| ---------------------------------- | -------------------------------------------------------- |
| `index.server.ts`                  | Controlled server-only API                               |
| `create-logger.server.ts`          | Pino construction and base configuration                 |
| `logger.server.ts`                 | Shared root logger and context-aware child logger access |
| `log-context.ts`                   | Framework-independent typed context and status contracts |
| `request-id.server.ts`             | Request ID validation and generation                     |
| `request-context.server.ts`        | `AsyncLocalStorage` request scope                        |
| `operation-timer.server.ts`        | Monotonic duration measurement                           |
| `safe-error.ts`                    | Safe error classification                                |
| `request-error-reporter.server.ts` | Next.js request-error adapter                            |

Node-only files import `server-only`. Pino, `node:async_hooks`, Node crypto,
and Node performance APIs are not exported through a client-safe entry. Domain
and application code must not import `src/platform`; future module entry points
will adapt these technical contracts at legal composition boundaries.

## Pino and structured JSON

The application uses one Pino root logger with these stable base fields:

```text
service=next-fullstack-starter
environment=<validated APP_ENV>
```

All environments emit the same JSON format. There is no human-formatted logger,
`pino-pretty`, remote transport, or logging provider. Pino supplies the standard
`trace`, `debug`, `info`, `warn`, `error`, and `fatal` methods; `silent` is a
supported configured level.

The default level policy is:

| Environment   | Minimum level |
| ------------- | ------------- |
| `development` | `debug`       |
| `test`        | `silent`      |
| `staging`     | `info`        |
| `production`  | `info`        |

Tests that inspect logs inject an in-memory destination and explicit level.
`LOG_LEVEL` is intentionally not an environment setting in this foundation;
the fixed policy is the smallest predictable configuration supported by the
current validated environment contract.

Every meaningful record uses a stable event name as the Pino message and puts
searchable dimensions in typed fields. Event messages must not contain
arbitrary user input or prose that changes the query contract.

## Typed context and child loggers

`LogContext` is closed to explicit optional fields:

```text
requestId
jobId
userId
actorType
organizationId
module
operation
route
method
routerKind
locale
durationMs
status
errorCode
```

`status` is one of `started`, `succeeded`, or `failed`. Authentication and job
fields are placeholders for correlation only; this implementation does not
resolve an actor, authorize a request, or run a background job.

Pino child loggers inherit their parent's bindings, destination, level, and
redaction configuration without mutating the root or sibling loggers.
`getRequestLogger` adds the current request scope when one exists and returns a
root-derived logger when it does not. It never creates persistent global
request state.

## Request ID contract

The stable header is:

```text
x-request-id
```

Only an RFC 4122 UUID v4 string in its bounded canonical form is trusted as an
incoming correlation value. A missing, empty, malformed, oversized, or
non-string value is replaced with `crypto.randomUUID()`. A request ID is only a
correlation identifier; it is not identity, authentication, authorization, or
proof of origin.

For paths currently handled by `src/proxy.ts`, the proxy:

1. validates or creates the ID;
2. places it on the request headers before `next-intl` creates its response, so
   Next.js can forward it to downstream server handling;
3. places the same ID on the outgoing response.

The locale matcher and locale-cookie behavior are unchanged. This integration
does not cover every future API, webhook, cron, Server Action, Route Handler, or
job boundary.

## Request context lifecycle

`RequestContext` requires `requestId` and may carry other currently known typed
fields. The server API provides:

```text
runWithRequestContext
getRequestContext
requireRequestContext
```

`runWithRequestContext` uses `AsyncLocalStorage.run()`. The context follows
awaited promises, remains isolated between concurrent and nested scopes,
preserves callback return values, rethrows callback errors unchanged, and is
unavailable after the callback completes or fails.

`getRequestContext` returns `undefined` outside a scope.
`requireRequestContext` throws a predictable diagnostic error outside a scope.
No plain mutable global or `enterWith()` is used for request state.

The proxy propagates the header but does not itself initialize
`AsyncLocalStorage` around all Next.js work. Future action and route composition
boundaries must call `runWithRequestContext` explicitly.

## Operation timing and events

`startOperationTimer` uses Node's monotonic performance clock and reports finite,
non-negative milliseconds at consistent microsecond precision. It does not wrap
operations, choose levels, or catch failures.

The implemented event identifiers are:

```text
application.started
request.failed
operation.started
operation.succeeded
operation.failed
job.started
job.succeeded
job.failed
```

The job identifiers reserve a consistent lifecycle vocabulary; no job runtime,
queue, worker, or job context initialization exists.

## Error logging policy

`toSafeLogError` recognizes `ApplicationError` by its internal class identity
and preserves only its stable `ErrorCode`. Unknown `Error` instances and
non-Error thrown values become `INTERNAL_ERROR` with a closed `errorType`.

The safe representation contains only:

```text
errorType
errorCode
```

It excludes message, stack, cause, class name, arbitrary properties, Prisma
metadata, SQL, provider payloads, headers, cookies, and tokens. Expected
validation, unauthenticated, forbidden, not-found, and conflict errors are
reported at `warn`; unexpected and internal failures are reported at `error`.
Logging failure while reporting a request error is contained so it does not
replace the original application behavior.

The Pino serializers for fields named `err` and `error` also apply the safe
classifier as defense in depth. Callers must still never attach raw errors.

## Redaction and prohibited data

Pino removes centrally configured common casing and nested forms of:

```text
password
currentPassword
newPassword
confirmPassword
passwordHash
token
accessToken
refreshToken
idToken
sessionToken
apiKey
secret
clientSecret
authorization
cookie
cookies
request
req
session
```

Redaction paths are application-controlled and cannot be supplied by user
input. Redaction is only defense in depth. Production code must never log raw
request or response objects, bodies, header collections, cookies, sessions,
environment objects, database records, Prisma or SQL errors, provider payloads,
authentication tokens, payment data, or arbitrary personal data.

Production source uses the structured logger. ESLint rejects `console.*` in
`src` production files; tests and build tooling remain narrowly outside that
rule.

## Next.js instrumentation

`src/instrumentation.ts` implements stable `register` and `onRequestError`
exports. It remains small and dynamically imports the Node-only implementation
only when `NEXT_RUNTIME` is `nodejs`, preventing Pino and
`AsyncLocalStorage` from entering a non-Node bundle.

`register` emits `application.started` at most once per loaded server instance
and makes no network call. `onRequestError` delegates to the testable platform
reporter, reads only the request-ID header, uses the route template rather than
the full query-bearing URL, and logs no raw headers or request object.

No obsolete instrumentation flag, client instrumentation, OpenTelemetry, or
Sentry integration is present.

## Correct usage

Initialize the scope at an actual server boundary and derive a contextual
logger:

```ts
await runWithRequestContext({ requestId }, async () => {
  const logger = getRequestLogger({
    module: "catalog",
    operation: "product.list",
  });

  logger.info({ status: "started" }, "operation.started");
});
```

Measure an important operation without changing its behavior:

```ts
const timer = startOperationTimer();
const result = await operation();

getRequestLogger({ module: "catalog", operation: "product.list" }).info(
  {
    status: "succeeded",
    durationMs: timer.elapsedMs(),
  },
  "operation.succeeded",
);
```

## Prohibited usage

```ts
logger.info({ headers: request.headers }, "request.received");
logger.info({ body }, "request.received");
logger.info({ session }, "session.loaded");
logger.error({ error }, "request.failed");
logger.error({ ...error }, "request.failed");
console.log("request started");
```

Do not place user-facing or localized text in event names or context fields.

## Deferred integration and production processing

Future Server Action and Route Handler factories, APIs, webhooks, cron
boundaries, and job workers must explicitly initialize or propagate request or
job context. Authentication may later populate actor fields after identity is
actually verified. Those integrations, complete proxy composition, audit
storage, metrics, traces, and alerting are not implemented.

Production emits JSON to the process output stream. The deployment platform is
responsible for collection, retention, access control, indexing, and alerting.
No log shipper or remote provider is configured in this repository.
