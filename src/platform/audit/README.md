# Application audit platform

A generic, append-only record of things that happened, owned by this directory
and usable by any module.

It began as the authorization audit trail and was widened deliberately. The
trail is no longer "what an administrator did to a user"; it is "what was done,
by whom, to what, and how it ended", and identity is simply its first caller. A
future documents module records `documents.document.published` here without
importing anything from `platform/auth`.

## The one rule

```
platform/auth      → platform/audit
business modules   → platform/audit
app composition    → platform/audit + the modules that declare actions

platform/audit     → nothing above
```

The audit platform must never import `platform/auth`. If it did, a module could
not audit anything without inheriting this application's opinion about how
people sign in — and the whole point of moving the trail out of authorization
would be lost. An ESLint block and four dependency-cruiser rules enforce the
direction; a contract test asserts they exist.

## What lives here

| File                                 | Owns                                                     |
| ------------------------------------ | -------------------------------------------------------- |
| `audit-action.ts`                    | `defineAuditAction`, the name and resource-type grammar  |
| `audit-actor.ts`                     | who acted: a user with a session, or the system          |
| `audit-result.ts`                    | `succeeded` / `failed` / `denied`                        |
| `audit-metadata.ts`                  | the JSON, forbidden-key, and size policy                 |
| `audit-identifier.ts`                | the request- and resource-identifier shapes              |
| `audit-catalog.ts`                   | an immutable set of definitions a reader interprets with |
| `audit-cursor.ts`                    | the opaque keyset position                               |
| `audit-query.ts`                     | the bounded list query                                   |
| `audit-record.ts`                    | the write, the stored row, the reader DTO                |
| `audit-repository.server.ts`         | the only data access; append and bounded read            |
| `append-audit-record.server.ts`      | the transactional writer                                 |
| `record-audit-post-commit.server.ts` | the post-commit writer                                   |
| `list-audit-records.server.ts`       | the reader                                               |
| `presentation/`                      | the admin table, which knows no vocabulary of its own    |

`index.server.ts` is the entry point. The repository is not exported: every
write goes through a writer and therefore through the metadata policy, and every
read goes through the reader and therefore through a catalog.

## Declaring an action

An action belongs to whoever performs it, never to this directory.

```ts
export const documentPublished = defineAuditAction({
  name: "documents.document.published",
  resourceType: "documents.document",
  metadataSchema: z.object({ version: z.number().int().min(1) }).strict(),
});
```

`name` is `<owner>.<resource>.<action>` and `resourceType` is
`<owner>.<resource>`; both are lowercase ASCII with hyphens allowed inside a
part, and both are bounded. The two are declared separately because they do not
always agree: `identity.session.revoked` records `identity.user`, because the
thing it happened to is a user.

The metadata schema must be a `.strict()` object. That is what makes "only these
fields are ever stored" true rather than aspirational.

## Writing a record

**Inside your transaction, whenever you can.**

```ts
await database.$transaction(async (tx) => {
  const document = await tx.document.update({ ... });

  await appendAuditRecord(tx, documentPublished, {
    actor,
    resourceId: document.id,
    result: AUDIT_RESULT.SUCCEEDED,
    requestId,
    metadata: { version: document.version },
  });
});
```

The record and the change share a commit. A rollback removes both; a failed
audit write fails the transaction, so an unauditable change does not happen.
`appendAuditRecord` refuses the Prisma singleton at runtime as well as in the
type, because a `PrismaClient` structurally satisfies `TransactionClient` and
the mistake would be invisible until a rollback failed to remove the record.

**After the fact, only when there is no transaction to join.**

```ts
const written = await recordAuditPostCommit(documentPublished, { ... });
```

This is for a change some other system already committed — a Better Auth
mutation is the standing example. It answers `false` instead of throwing,
because the change is done: reporting it as failed would be a lie and retrying
it would apply it twice. **A record can be lost here.** There is no
reconciliation. The failure is logged as `audit.record.write_failed`.

## Reading

```ts
const page = await listAuditRecords(catalog, { limit: 20, cursor });
```

Newest first, `occurredAt DESC, id DESC`, keyset paging. No offset — an
append-only table shifts under an offset reader — and no total, because
`count(*)` on a growing table is a sequential scan that is stale by the time it
renders. The reader fetches `limit + 1` rows to learn whether there is another
page, returns `limit`, and hands back a cursor naming the last row it returned.

Authorization is **not** in the reader. `audit.record.read` is required by the
entry points: declared on the Route Handler, checked by the page. That is the
cost of the platform staying free of `platform/auth`, and it is why a contract
test asserts both entry points still require it.

### An action the catalog does not know

Keep the row. Show the action name, the actor, the resource, the result, and the
identifiers; return `metadata: null`. A record that vanished because someone
deleted a definition would be worse than a missing detail column, and the raw
stored value is never passed through — it was written under a contract that no
longer holds.

## Privacy

Metadata is the only open-ended field, so it has four defences: a closed
`.strict()` schema per action, a JSON-only check that refuses a `Date`, a `Map`,
a `Buffer`, an `Error`, a class instance, `NaN`, and a cycle, a recursive
case-insensitive scan for known-dangerous key names, and a 4096-byte ceiling
that the database repeats as a constraint.

None of that detects personal data in general. A field called `note` can hold an
email address and no automated check will know. **Closed schemas and code review
are the policy**; the defences narrow the accident surface.

`actorSessionId` is stored for investigation and is selected by nothing — not by
the reader, not by the DTO, not by the API, not by the page.

## Storage

`audit_record`, in `prisma/audit.prisma`. No foreign key to `user`, to
`session`, or to any business model: a record must outlive what it refers to.
The action is a pattern-constrained string rather than a database enum, so
adding an audited action needs no migration.

Append-only means the application exposes create and read only. There is no
trigger forbidding `UPDATE` or `DELETE`, because a trigger would also block the
operator who legitimately has to correct or erase a row, and a superuser could
drop it anyway. Those operations belong to a DBA with separate credentials.

## Not here

No retention policy, no cold archival, no bulk export, no compliance report, no
SIEM integration, no reconciliation, and no background audit job. The trail
grows without bound today; see
[the architecture document](../../../docs/architecture/application-audit-platform.md)
for what that means operationally.
