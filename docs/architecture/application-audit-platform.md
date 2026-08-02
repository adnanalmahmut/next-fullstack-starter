# Application audit platform

## What changed, and why

The audit trail used to belong to authorization. It recorded two things — a role
change and a session revocation — it stored them in a table named after
authorization, and every part of it was typed against identity: the actor was a
user id, the target was a user id, and the action was a database enum with two
values.

That was the right shape for one caller and the wrong shape for the second. A
documents module that wanted to record "this document was published" had three
options: write its own table, import `platform/auth` to reach the recorder, or
widen an enum owned by authentication. All three are wrong, and the third is the
most tempting.

So the trail moved out. `src/platform/audit` owns a generic record — an actor, an
action, a resource, a result, and validated metadata — and identity is now one
of its callers rather than its owner. Everything else in this document follows
from that move.

## Ownership and direction

```
platform/auth      → platform/audit
business modules   → platform/audit
app composition    → platform/audit + whoever declares the actions

platform/audit     → nothing above
```

The audit platform must not import `platform/auth`, a business module, routing,
translations, React outside its own presentation directory, Redis, BullMQ, the
cache, or the concurrency controls. It may reach Prisma, because the trail is a
table and a record has to be written in the caller's transaction.

Enforced by the `architecture/audit-platform` and
`architecture/audit-presentation` ESLint blocks and by four dependency-cruiser
rules: `no-audit-platform-internal-imports`, `no-audit-to-authentication`,
`no-audit-to-presentation`, `no-audit-to-infrastructure-clients`. A contract
test asserts all six exist, and that the directory needs no exception to pass.

What a module needs in order to audit something is a definition and a writer.
It does not need to know that Better Auth exists, what an `Actor` is, what
`AuthorizationAuditRecord` was, or which Prisma delegate is behind any of it.

## Action definitions

An action is declared by whoever performs it:

```ts
export const userRoleSetAudit = defineAuditAction({
  name: "identity.user.role-set",
  resourceType: "identity.user",
  metadataSchema: z.object({ role: z.enum(AUTHORIZATION_ROLE_NAMES) }).strict(),
});
```

- `name` is `<owner>.<resource>.<action>`; `resourceType` is
  `<owner>.<resource>`. Lowercase ASCII, hyphens allowed inside a part, no
  wildcards, no empty parts, both bounded.
- The two are declared separately because they do not always agree.
  `identity.session.revoked` records `identity.user`, because a user is what it
  happened to. Deriving the resource type from the action name would have made
  that unsayable.
- The platform holds no action of its own, and a contract test fails if an
  action literal appears inside it.
- A call site passes the definition object, never a bare string.

Adding an action does **not** require a database migration: the column is a
pattern-constrained string, not an enum.

## The catalog

`createAuditCatalog(definitions)` produces an immutable lookup. It is a value a
composition root builds — `src/app/_composition/audit-catalog.ts` — and hands to
a reader. It is deliberately not a registry: nothing registers itself, no module
has an import side effect, and there is no global whose contents depend on
module evaluation order.

Duplicate names throw at construction. Two definitions under one name means two
metadata shapes claiming the same rows, and the winner would be decided by array
order.

### Reading an action the catalog does not know

This is the case the design exists for: a record written today, and the module
that declared its action deleted next year. The rule is

- keep the record;
- show the action name, the actor, the resource, the result, and the
  identifiers;
- return `metadata: null`;
- never pass the raw stored value through.

A record that vanished from an audit trail because of a refactor would be worse
than a record with an empty detail column, and the raw metadata was written
under a contract that no longer holds.

## Actor

```ts
type AuditActor =
  | { type: "user"; id: string; sessionId: string }
  | { type: "system"; id: string };
```

No email address, no display name, no roles, no token, no cookie, no IP address,
no user agent, no headers. Roles in particular are excluded twice over:
recording one would invite a reader to reason about it, and this application
never decides access from a role.

A user actor always has a session; a system actor never does. That is a union
rather than an optional field, and a database check constraint repeats it for
anything that reaches the table another way. `platform/auth` converts its
verified `Actor` with `toAuditActor`, an explicit projection — so a field added
to `Actor` later does not silently start being written to the trail.

`actorSessionId` is stored for investigation and selected by nothing. It is not
in the reader's row shape, not in the DTO, not in the API response, and not on
the page.

## Result

`succeeded`, `failed`, `denied` — closed, and matched one for one by a database
enum.

Today this application records `succeeded` only. Every audited operation is a
completed administrative change, and there is **no global failure auditing**:
`failed` and `denied` exist because the contract belongs to the platform rather
than to its first caller, not because every refusal in the system is written
down. A record on every denial would turn the audit trail into an access log and
bury the changes it exists to show.

## Metadata policy

Four defences, in order:

1. **A closed schema per action.** Object schemas must be `.strict()`, so an
   unknown key is refused rather than stripped.
2. **JSON, narrowly.** Plain objects, arrays, strings, finite numbers, booleans,
   `null`. A `Date`, `Map`, `Set`, `Buffer`, `Error`, class instance, function,
   symbol, `bigint`, `undefined`, `NaN`, `Infinity`, or cycle is refused rather
   than coerced — coercion is how a stack trace becomes a string.
3. **A recursive, case-insensitive forbidden-key scan**, covering at least
   `password`, `passwordHash`, `token`, `accessToken`, `refreshToken`,
   `sessionToken`, `cookie`, `cookies`, `authorization`, `secret`,
   `clientSecret`, `apiKey`, `email`, `displayName`, `fullName`, `ipAddress`,
   `userAgent`, `headers`, `request`, `requestBody`, `responseBody`, `body`,
   `error`, `stack`.
4. **A 4096-byte ceiling** on the serialized value, repeated as a database
   constraint.

Metadata is parsed on write and parsed again on read.

> **PII detection cannot be automated.** A field called `note` can hold an email
> address and no scan will know. The forbidden-key list narrows the accident
> surface; **closed action-specific schemas plus code review are the policy**.

Identifiers are never stored in metadata — the actor, the resource, and the
request each have their own column. The two shapes this application records
today are `{ role }` and `{ scope: "all" }`.

## Writing

### Transactional — `appendAuditRecord(tx, definition, input)`

Takes a `Prisma.TransactionClient`, so there is no way to call it _beside_ a
change rather than _with_ one. The record and the change share a commit:

- the transaction rolls back → the record is gone;
- the audit write is refused → **the transaction fails, and the change does not
  happen**;
- the audit write fails at the database → the same.

That last point is the important one and it is not an accident: a failure here
must propagate. Swallowing it would leave a change committed and unrecorded,
which is the outcome the transactional writer exists to prevent.

It contacts nothing — no Redis, no queue, no outbox row, no network call. Any of
those would be an unbounded wait inside a transaction holding row locks, and one
of them could succeed against a transaction that then rolls back.

It also refuses the Prisma singleton at runtime, not only in the type: a
`PrismaClient` structurally satisfies `TransactionClient`, and the mistake would
be invisible until a rollback failed to remove the record. The discriminator is
`$connect`/`$disconnect`, which an interactive client does not expose. (It does
still expose `$transaction`, so that is not the discriminator it looks like.)

### Post-commit — `recordAuditPostCommit(definition, input)`

For a change some other system already committed. It answers `true` or `false`
and never throws.

**A record can be lost here.** The window is small and there is no
reconciliation. Throwing instead would push the failure to a caller who can only
do one of two wrong things: report a completed change as failed, or retry it and
apply it twice. The second is considerably worse than a missing audit record.

The failure is logged as `audit.record.write_failed`, with a closed field
allowlist: `action`, `actorType`, `actorId`, `resourceType`, `resourceId`,
`result`, `requestId`, and a safe `errorCode`. Never metadata, never
`actorSessionId`, never the raw error, message, or stack — a driver exception
carries the statement, its parameters, and sometimes the connection string.

### Which one the current operations use

Better Auth's `setRole` and `revokeUserSessions` are **post-commit**, and that is
forced rather than chosen: by the time the guard hook runs, the provider has
already committed, and there is no transaction of ours left to join. Opening one
after the fact would look stronger while guaranteeing nothing.

The semantics from before the platform are preserved exactly: a record only
after the mutation succeeded, exactly one per successful mutation, none for a
refusal, and a failed write never turns a completed change into a retryable
failure. The guard covers `/api/auth/admin/...` and `auth.api.*` alike, so there
is one write path and no double auditing.

## Append-only

The application exposes create and read. There is no update, delete, upsert,
`deleteMany`, truncate, or export anywhere in the platform — the capability does
not exist in the code, and a contract test scans the directory for it.

There is deliberately **no trigger** forbidding `UPDATE` or `DELETE`. A trigger
would also block the operator who legitimately has to correct a row or erase one
for a data-subject request, and a superuser could drop it anyway. Those
operations belong to a DBA with separate credentials and their own audit trail.

## Reading

```ts
listAuditRecords(catalog, { limit, cursor })
  → { records, limit, nextCursor }
```

- `occurredAt DESC, id DESC`. The identifier is the tie breaker, and it is not
  decoration: two records in the same millisecond would otherwise have no
  defined order, and a page boundary across them would repeat one and skip the
  other.
- `limit` is 1–50, default 20. No offset: an append-only table shifts under an
  offset reader.
- No total. `count(*)` on a growing table is a sequential scan and is stale by
  the time it renders.
- The reader fetches `limit + 1` rows to learn whether there is another page and
  returns `limit`. The extra row is never serialized.
- The cursor is base64url of `{ occurredAt, id }` — opaque because the shape is
  the platform's to change, not secret because every value in it was in the
  previous response. Malformed, oversized, mistyped, or carrying an unknown key:
  all `ValidationError`.

### Authorization is at the entry points

`listAuditRecords` takes no actor. The platform must stay usable by a module that
knows nothing about this application's authentication, so requiring a permission
inside the reader would invert the dependency the whole area is built around.

`audit.record.read` is therefore required by the Route Handler (declared) and by
the page (checked explicitly). Both are entry points, which is where an
authorization decision belongs. What is lost is the defence in depth of a second
check further in; a contract test asserts both entry points still require it.

## Permission

`identity.audit.read` → **`audit.record.read`**.

The old name was accurate while the trail only held identity changes. Now that
any module can write to it, a permission scoped to identity would grant a reader
access to records that have nothing to do with identity.

There is **no compatibility alias**. A permission that still resolves is a
permission still granted, and a rename that leaves one behind has renamed
nothing. `admin` holds it; `user` does not. `identity.admin.access` still guards
the administration area itself.

## Storage

`audit_record`, in `prisma/audit.prisma`:

| Column           | Notes                                         |
| ---------------- | --------------------------------------------- |
| `id`             | uuid7                                         |
| `occurredAt`     | defaults to now                               |
| `actorType`      | `audit_actor_type` enum                       |
| `actorId`        | `VarChar(255)`                                |
| `actorSessionId` | `VarChar(255)`, nullable, selected by nothing |
| `action`         | `VarChar(96)`, pattern-constrained string     |
| `resourceType`   | `VarChar(64)`                                 |
| `resourceId`     | `VarChar(255)`                                |
| `result`         | `audit_result` enum                           |
| `requestId`      | `VarChar(36)`, canonical UUID or null         |
| `metadata`       | `jsonb`, ≤ 4096 bytes                         |

Indexes: `(occurredAt, id)` for the listing and its keyset page,
`(actorType, actorId, occurredAt)`, `(resourceType, resourceId, occurredAt)`,
and `(action, occurredAt)`.

Named check constraints: `audit_record_actor_id_bounded`,
`_actor_session_id_bounded`, `_resource_id_bounded`, `_action_pattern`,
`_resource_type_pattern`, `_request_id_canonical`, `_metadata_bounded`,
`_actor_session_presence`.

**No foreign key** to `user`, `session`, or any business model. An audit record
must outlive what it refers to — the record of a deletion is worthless if the
deletion removes it — so `actorId` and `resourceId` are plain identifiers.

### Request identifiers

`requestId` comes from the trusted request-context header contract and nowhere
else: never from a body, never from a query parameter, never an arbitrary client
string. The platform re-validates the shape and the database repeats the
constraint. Absence is normal and is stored as `null`.

## The legacy trail

`authorization_audit_record` and `authorization_audit_action` are **frozen**.

- Structure unchanged, data unchanged, no new rows.
- Not dropped: it is the original of what was copied, and destroying it would
  leave the copy as the only evidence the records ever existed.
- No production code path reads or writes `database.authorizationAuditRecord`; a
  contract test scans `src` and fails if the delegate name appears.
- The Prisma comment says all of this. Only the comment changed.

### Backfill

The migration `establish_application_audit_platform` copies every legacy row
into `audit_record` once, with `INSERT ... SELECT`:

| Legacy           | New                                               |
| ---------------- | ------------------------------------------------- |
| `id`             | `id` — preserved, so a record keeps its identity  |
| `occurredAt`     | `occurredAt`                                      |
| `actorUserId`    | `actorId`, with `actorType = user`                |
| `actorSessionId` | `actorSessionId`                                  |
| `action`         | `action`, unchanged text                          |
| `targetUserId`   | `resourceId`, with `resourceType = identity.user` |
| `requestId`      | `requestId`                                       |
| `metadata`       | `metadata`                                        |
| —                | `result = succeeded`                              |

`succeeded` is correct for both actions because the legacy trail only ever held
completed changes. `identity.user` is correct for both because both targeted a
user, including the revocation.

Reading the SQL is not proof, so
`tests/integration/audit-backfill.integration.test.ts` runs it: it creates a
disposable schema, applies the migration history up to the previous pull request,
baselines it with `prisma migrate resolve --applied`, inserts one row of each
legacy action, runs `prisma migrate deploy` — which applies exactly the new
migration, through Prisma's normal history — and then asserts the identifiers,
timestamps, actors, actions, resources, request identifiers, metadata, and
result, that the legacy rows are still there, and that a second `deploy` copies
nothing again. Then it drops the schema.

## Admin reader

`GET /api/v1/admin/audit` and `/[locale]/admin/audit`, both unchanged as paths.

The route declares a name (`audit.record.list`), a query schema, a permission,
and an `execute`. It imports no Prisma, holds no business logic, and passes the
composed catalog. The page checks the capability, renders inside the existing
`Suspense` boundary, keeps `noindex, nofollow`, and works in Arabic and English.

The table lives in `src/platform/audit/presentation/` and imports no
authentication and no translation API: action labels, actor-kind labels, result
labels, the detail line, the date format, and the next-page link all arrive as
props from the composition root — the only layer that knows both the catalog and
the locale. That is what lets it render a future module's actions untouched.

It shows when, action, actor kind and id, resource type and id, result, and the
allowlisted detail. Identifiers carry `dir="ltr"` so the bidirectional algorithm
does not reorder a UUID around its hyphens. An unknown action shows its stable
name; withheld or absent metadata shows the "no detail" placeholder. There is no
export, delete, or edit control, because the platform has no operation behind
them.

## Factory integration

`defineAction` and `defineRoute` are unchanged. They do not choose an audit
action, build metadata, import a definition, or record anything automatically —
what is worth auditing is a business decision belonging to the call site.

The `audit` route hook is a **post-success observer** and cannot be transactional
with the use case: by the time it runs, the mutation has committed. A definition
that wants the stronger guarantee writes the record inside its own transaction
with `appendAuditRecord`. A contract test asserts the factories import no audit
definition and that no `afterSuccess` hook opens a transaction.

## Known limitations

- **A post-commit record can be lost.** No reconciliation exists.
- **The trail grows without bound.** No retention policy, no cold archival, and
  no partitioning. Sizing and pruning are an operational task today.
- **No export and no compliance report.** Deliberately: an export endpoint is a
  bulk-disclosure endpoint, and it needs its own threat model.
- **No SIEM integration.** Records stay in PostgreSQL.
- **No background audit job.** Nothing about the trail depends on Redis, on
  BullMQ, or on a worker being alive.
- **Append-only is an application guarantee**, not a database one. A DBA can
  still correct or remove a row, and should have to.
- **PII detection is not automated.** Closed schemas and review are mandatory.
- **The reader has no filters.** Newest-first paging only; "everything this
  actor did" is supported by an index but not yet by an endpoint.
