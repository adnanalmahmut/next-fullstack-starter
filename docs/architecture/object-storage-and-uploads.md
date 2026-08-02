# Object storage and uploads

`src/platform/storage` is an optional, S3-compatible object storage platform. It
gives a future module a complete direct-upload cycle — authorize an upload,
let the browser send the bytes to the provider, verify them, promote them to an
immutable object, and hand out short-lived private download links — without the
application ever touching a byte.

It is a **capability, not a feature**. There is no documents module, no upload
page, no admin screen, no public endpoint, and no permission. Those belong to
whichever module eventually needs to store a file.

## Ownership

The platform owns:

- storage configuration, read lazily
- upload policies and the file declaration contract
- storage object identities and the key layout
- upload intents, their leases, and their lifecycle
- the provider port and its one S3-compatible adapter
- presigned uploads, verification, promotion, and presigned downloads
- the content inspection extension point
- the bounded cleanup and health contracts
- safe logging for all of the above

It does **not** own, and deliberately cannot answer:

| Question                                 | Whose it is                                                           |
| ---------------------------------------- | --------------------------------------------------------------------- |
| Who may upload a file?                   | The calling module                                                    |
| Who may download this object?            | The calling module                                                    |
| Which business record does it belong to? | The calling module                                                    |
| Should it be published?                  | The calling module — and the answer is never "make the bucket public" |
| Is the content safe?                     | A `StorageContentInspector`, which this repository does not implement |

`createStorageDownloadUrl` takes no actor and asks no question about one. A
caller that forgets to authorize is a defect in the caller; a `userId` parameter
here would only have moved the mistake, because the platform still could not
have known whether that user is allowed to read that file.

## Dependency direction

```
future modules      → platform/storage
app composition     → modules + platform/storage

platform/storage    → config
platform/storage    → database
platform/storage    → observability
platform/storage    → shared/errors

storage/provider    → AWS SDK v3
```

Nothing runs the other way. The platform must not reach `platform/auth`,
`platform/audit`, `platform/redis`, `platform/cache`, `platform/concurrency`,
`platform/jobs`, `src/worker`, `src/modules`, `src/app`, `src/ui`, React, or
`next-intl`. Four dependency-cruiser rules, two ESLint blocks, and
[`tests/contract/object-storage-uploads.contract.test.ts`](../../tests/contract/object-storage-uploads.contract.test.ts)
hold that.

The AWS SDK is narrower still: it lives in `src/platform/storage/provider` and
nowhere else, behind a port that names no AWS type. Swapping the SDK, or the
provider, is a change to one directory.

## Optionality

`STORAGE_ENABLED=false` — the default — means:

- no credential is read
- no S3 client is constructed
- no hostname is resolved and no socket is opened
- `pnpm verify`, `pnpm build`, and every default suite pass with no bucket
  anywhere

Nothing is read at import time. `src/config/env/index.server.ts` exports no
`storageEnv`, because doing so would make a bucket part of startup validation.
The configuration is read on the first call that genuinely needs one, memoized
per process, and exposed as a discriminated union so a caller that has checked
`enabled` gets the bucket without an assertion.

CI proves this rather than asserting it: the whole job runs with
`STORAGE_ENABLED: "false"` and no endpoint, bucket, or credential in the job
environment. One step — `Run storage integration tests` — enables storage.

## Configuration

| Variable                                                    | Required                     | Notes                                                                                                                     |
| ----------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_ENABLED`                                           | —                            | Defaults to `false`. Nothing else is required while it is off.                                                            |
| `STORAGE_REGION`                                            | when enabled                 | Lowercase. `auto` for R2.                                                                                                 |
| `STORAGE_BUCKET`                                            | when enabled                 | Held to the S3 naming rules. Must be private.                                                                             |
| `STORAGE_ENDPOINT`                                          | in practice for MinIO and R2 | `http` or `https`. Omitting it selects AWS S3's own regional endpoint. **There is no default and no localhost fallback.** |
| `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY`       | together or not at all       | Omitting both selects the AWS default credential chain.                                                                   |
| `STORAGE_SESSION_TOKEN`                                     | —                            | Only alongside a complete pair.                                                                                           |
| `STORAGE_FORCE_PATH_STYLE`                                  | —                            | `true` for MinIO.                                                                                                         |
| `STORAGE_KEY_PREFIX`                                        | —                            | The first segment of every key.                                                                                           |
| `STORAGE_CONNECT_TIMEOUT_MS` / `STORAGE_REQUEST_TIMEOUT_MS` | —                            | Bounded integers.                                                                                                         |
| `STORAGE_UPLOAD_URL_TTL_SECONDS`                            | —                            | Must not exceed the intent lifetime.                                                                                      |
| `STORAGE_DOWNLOAD_URL_TTL_SECONDS`                          | —                            | The ceiling a caller's request is clamped to.                                                                             |
| `STORAGE_UPLOAD_INTENT_TTL_SECONDS`                         | —                            | How long an authorization lives.                                                                                          |
| `STORAGE_FINALIZE_LEASE_MS`                                 | —                            | Must be shorter than the intent lifetime.                                                                                 |
| `STORAGE_MAX_UPLOAD_BYTES`                                  | —                            | Capped at 5 GiB, the largest a single request can carry.                                                                  |
| `STORAGE_TEST_RUN_ID`                                       | —                            | Isolates one test run's keys from another's.                                                                              |

Half a credential pair is refused rather than guessed at: falling back to the
default chain because the secret was missing would silently sign requests as
whichever identity the host happens to carry.

### Provider differences

|               | Endpoint                                     | Region                     | Path style |
| ------------- | -------------------------------------------- | -------------------------- | ---------- |
| AWS S3        | omit                                         | the real region            | `false`    |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | `auto`                     | `false`    |
| MinIO         | `http://127.0.0.1:9000`                      | anything, e.g. `us-east-1` | `true`     |

All three run through the same adapter. **The bucket must be private in all
three.** The application never issues a public URL, never sets an ACL, and never
sends `x-amz-acl`; a bucket that is readable anonymously would make every one of
those precautions pointless.

## Upload policies

A policy is a value, built by server-owned code and passed to the platform by
the call site:

```ts
const invoiceUpload = defineUploadPolicy({
  name: "billing.invoice",
  allowedFiles: [{ contentType: "application/pdf", extensions: ["pdf"] }],
  maxBytes: 5 * 1024 * 1024,
  inspection: "required",
});
```

It is deliberately **not** a registry. There is no global table to look a name up
in, and no call site passes a bare policy name — a name resolved through a
mutable table is a name a request could eventually supply, and "which policy
applies" would stop being a decision the server made.

Media types are exact. `image/*` is refused, because a wildcard is how an
allowlist quietly becomes a denylist: it admits `image/svg+xml`, which is a
document that executes script in the browser that opens it. Every media type
declares its own extensions, and no extension may be claimed by two of them.

This repository ships **no policy of its own**. The only ones here are test
fixtures.

## Keys: staging versus final

```
<prefix>/<environment>/<test-run>/staging/<48 hex characters>
<prefix>/<environment>/<test-run>/objects/<48 hex characters>
<prefix>/<environment>/<test-run>/quarantine/<48 hex characters>
```

The `<test-run>` segment exists only under `APP_ENV=test`.

Every key is generated server-side from 192 bits of randomness and carries **no
information at all** — not the original filename, not a user identifier, not an
email address, not a business identifier. Object keys appear in provider access
logs, bucket listings, billing exports, and support conversations, and a
filename like `medical-report-2026-ahmad.pdf` should reach none of them.

The staging key and the final key are generated **independently**. The client
sees the staging key inside its upload form; if the final key were derivable
from it, the guarantee below would rest on the provider's access control alone.

**The client never learns the final key.** It is not in the intent response, not
in the object metadata DTO, and not in any error.

## The upload cycle

```
module                     platform                      provider
  │                            │                             │
  ├── createUploadIntent ─────►│                             │
  │                            ├── insert object + intent    │
  │                            ├── sign a POST policy ──────►│
  │◄── intentId, objectId, ────┤                             │
  │    finalizeToken, form     │                             │
  │                            │                             │
  ├────────── (the browser POSTs the bytes) ────────────────►│
  │                            │                             │
  ├── finalizeUploadIntent ───►│                             │
  │                            ├── claim the intent (atomic) │
  │                            ├── HEAD staging ────────────►│
  │                            ├── verify size / type / hash │
  │                            ├── inspect (optional)        │
  │                            ├── conditional copy ────────►│
  │                            ├── HEAD final ──────────────►│
  │                            ├── commit: object ready      │
  │                            ├── delete staging (best effort)
  │◄── object metadata ────────┤                             │
```

The presigned POST pins one key, one media type, and the declared size as **both
ends** of a `content-length-range`. A presigned PUT would sign a URL and accept
whatever body arrived at it; a POST signs a _policy_, so the provider refuses an
oversized upload before the object exists.

### The finalize token

Returned exactly once, at creation. Only its SHA-256 is stored, so a database
dump contains nothing that can finalize an upload. It is 256 random bits rather
than a UUID — a value shaped like an identifier ends up in a URL path or a log
line because every other UUID safely does. It never appears in a log, an error,
an audit record, an object key, or a query string. Comparison is constant-time,
and **a wrong token is answered exactly like an unknown intent**, so neither can
be used to probe for the other.

### The lease

PostgreSQL is the coordination point. Not Redis, not a distributed lock. A
finalization claims the intent with a conditional update on `(status, version)`
and holds a bounded lease while it talks to the provider:

- two concurrent attempts produce one winner and one `CONFLICT`
- a replay with the right token returns the same object rather than an error
- a lease that expires can be reclaimed, and the version increments — so the
  attempt that lost it writes nothing when it comes back
- no database transaction is open while a provider call is in flight

### Verification

`HEAD` gives the actual size, the stored media type, and — when the provider
computed one — a SHA-256. When it did not, the object is streamed and hashed
server-side, bounded by the declared size, aborting the moment it is exceeded:
a `Content-Length` is a claim like any other.

The ETag is **not** used as a checksum. For a multipart or server-side-encrypted
object it is not the MD5 of the content, and it is never a SHA-256 under any
condition.

### Immutability

After verification, a **server-side conditional copy** promotes the staged bytes
to the final key, with `CopySourceIfMatch` on the entity tag read during
verification. That closes the window between checking and promoting: a client
that re-uploads in between changes the tag and the copy fails.

The guarantee this produces:

> Reusing the presigned staging upload after finalization cannot change the
> object a module later reads.

It holds because the final key is never presigned for upload, and the client is
never told what it is. Two integration tests prove it against MinIO — one
replays the upload form with different bytes and downloads the original back,
and one swaps the staged object mid-finalization and watches the conditional
copy refuse.

## Content type is not content

Three statements the documentation makes deliberately:

- **A declared media type and extension prove nothing.** They are what the
  browser guessed. A Windows executable declared `application/pdf` with a
  correct SHA-256 passes every check this platform makes.
- **SHA-256 proves the bytes match the declaration, not that they are safe.** It
  is an integrity check, not a judgement.
- **`inspection: "optional"` does not mean the file was scanned.** With no
  inspector configured the stored result is `not-configured`, which is a
  first-class outcome precisely so it can never be mistaken for `clean`.

`inspection: "required"` **fails closed**: without an inspector, finalization
refuses with `DEPENDENCY_UNAVAILABLE` and no object becomes ready.

An inspector that answers `quarantine` sends the bytes to the quarantine
namespace and the object to `QUARANTINED`. No download is ever signed for it,
and it is indistinguishable to a caller from an object that does not exist —
the difference between "no such file" and "that file was withheld" is
information about what somebody uploaded. The bytes are kept, because they are
the evidence.

This repository implements **no** scanner. There is no ClamAV, no external
service, and no magic-byte sniffing. The tests use a fake.

## Failure semantics

There is **no exactly-once transaction between PostgreSQL and S3**, and the
platform does not pretend otherwise. Three windows, handled differently:

| When                                                         | What happens                                                                                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider fails **before** the copy                           | The lease is released, the intent returns to `pending`, and the client may retry within its original lifetime. Nothing was written to the bucket, and the expiry is not extended. |
| Provider fails **after** the copy, before the commit         | A final object may exist that no ready row points at. The platform does not claim success, issues no download, and leaves the intent in a state cleanup recognizes.               |
| Deleting the staged copy fails **after** a successful commit | A completed finalization is never turned back into a retryable failure. A warning is logged and cleanup removes the leftover later.                                               |

Errors map to the project's existing contracts: invalid declaration →
`ValidationError`; unknown intent or object → `NotFoundError`; state, version,
or lease conflict → `ConflictError`; storage disabled or provider unreachable →
`DependencyUnavailableError`. No provider message, request identifier, bucket,
key, or endpoint reaches a public error.

## Cleanup

`cleanupExpiredUploadIntents({ limit })` is a **contract, not a job**. Nothing
schedules it: there is no cron, no queue, no worker, and no timer anywhere in
this platform. A deployment that wants it run wires it to whatever scheduler it
already has.

It collects expired `pending` intents, `finalizing` intents whose lease _and_
lifetime have both lapsed, and the orphan a crashed finalization may have left
at the final key. It deletes only keys a PostgreSQL row names — never by listing
the bucket, never by prefix, never a key it computed. It cannot reach a `ready`
object, and it never deletes a quarantined one. The batch is bounded, ordering is
stable, and a failed delete does not stop the rest of the pass.

## Health

`checkStorageHealth()` answers `disabled`, `healthy`, `unavailable`, or
`misconfigured`. Disabled is answered from configuration alone, so a readiness
probe on a project that stores nothing costs nothing. `misconfigured` means the
provider answered and said no — a missing bucket, a refused credential — which
restarting will not fix. The check is a bounded `HeadBucket`: it creates and
deletes nothing.

No route is added in this change. PR #22 will use this contract for readiness.

## Logging

Every line goes through `toStorageLogFields`, which drops anything outside its
allowlist: `intentId`, `objectId`, `policyName`, `outcome`, `reasonCode`,
`requestId`, `errorCode`, `durationMs`, `deleted`, `examined`.

A signed URL, a presigned field, a finalize token, a token hash, a credential, a
bucket, an endpoint, a storage key, a filename, a checksum, and a raw provider
error appear in none of them. The line reporting a failure is exactly the line
where somebody will want to attach the URL "so it is not lost", which is why the
allowlist is enforced by construction rather than at each call site.

## Bytes never pass through Next.js

`defineRoute` is unchanged: no multipart parsing, no `FormData`, no change to
`RouteInputSchemas` or `readJsonBody`. The intended flow is:

1. A module requests an upload intent through an ordinary JSON action or route.
2. The **browser** posts the bytes straight to the object store.
3. The module finalizes through an ordinary JSON action or route.

That keeps the request path free of large bodies, keeps memory and timeouts
predictable, and works identically on a serverless host.

## Testing

| Suite                    | Command                         | Needs                           |
| ------------------------ | ------------------------------- | ------------------------------- |
| Unit                     | `pnpm test:unit`                | nothing                         |
| PostgreSQL integration   | `pnpm test:integration`         | the test database               |
| Contract                 | `pnpm test:contract`            | nothing                         |
| Object store integration | `pnpm test:storage:integration` | MinIO **and** the test database |

The last one is deliberately outside `vitest.config.ts`, so it cannot be reached
by `pnpm test` or the coverage run. Start MinIO with `pnpm storage:test:up`.

Every object a run writes lives under its own key prefix, and cleanup lists that
prefix alone — two runs against one bucket, including two CI runs, cannot see or
delete each other's objects. The suite creates its own bucket idempotently,
never applies a bucket policy, never deletes the bucket, and asserts at the end
that its own prefix is empty and that a sentinel belonging to another run is
untouched.

## Removing object storage

1. Delete `src/platform/storage`.
2. Delete `prisma/storage.prisma` and add a migration dropping the two tables.
3. Delete `compose.storage.yaml`, `compose.storage.env.example`,
   `vitest.storage.config.ts`, `tests/storage`, and
   `tests/fixtures/storage.fixture.ts`.
4. Remove the `storage:*` and `test:storage:integration` scripts, the three
   `@aws-sdk/*` dependencies, the `STORAGE_*` block in
   `src/config/env/schema.ts`, and `src/config/env/read-storage.ts`.
5. Remove the storage blocks from `eslint.config.mjs`,
   `.dependency-cruiser.js`, and the CI workflow.

Redis, background jobs, caching, and auditing are unaffected. Each area is
removable on its own, which is why none of them shares a helper with the others.
