import { randomUUID } from "node:crypto";

import { loadEnvConfig } from "@next/env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import type { Prisma } from "@/generated/prisma/client";

loadEnvConfig(process.cwd());

vi.doMock("server-only", () => ({}));

const { database } = await import("@/platform/database/index.server");
const {
  appendAuditRecord,
  AUDIT_RESULT,
  createAuditCatalog,
  decodeAuditCursor,
  defineAuditAction,
  listAuditRecords,
  recordAuditPostCommit,
  userAuditActor,
} = await import("@/platform/audit/index.server");
const { ValidationError } = await import("@/shared/errors/application-error");

/**
 * The audit platform against a real PostgreSQL.
 *
 * The guarantees under test are the ones a unit test cannot reach: that a record
 * and the change it describes share a commit, that a keyset page neither repeats
 * nor skips a row when timestamps collide, that the acting session is stored and
 * never selected, and that the database refuses a row the application would have
 * refused.
 *
 * Every test owns its rows. Cleanup is by identifier, never by truncation, and
 * the suite refuses to run at all unless it is pointed at a local test database.
 */
const RESOURCE_TYPE = "testing.subject";
const ACTION_NAME = "testing.subject.changed";

const subjectChanged = defineAuditAction({
  name: ACTION_NAME,
  resourceType: RESOURCE_TYPE,
  metadataSchema: z.object({ scope: z.enum(["all", "one"]) }).strict(),
});

const catalog = createAuditCatalog([subjectChanged]);

/**
 * The stand-in for a business change.
 *
 * `Verification` is the smallest model in the schema with no foreign key, so a
 * row can be created and removed without touching identity data — and a
 * transaction can be observed committing or rolling back with the audit record.
 * Inventing a business module to test the platform would be the larger mistake.
 */
const SUBJECT_PREFIX = "audit-platform-";

function subjectId(): string {
  return `${SUBJECT_PREFIX}${randomUUID()}`;
}

function assertTestDatabase() {
  expect(process.env.APP_ENV).toBe("test");

  const host = new URL(process.env.DATABASE_URL ?? "postgresql://invalid")
    .hostname;

  expect(["127.0.0.1", "localhost", "::1"]).toContain(host);
}

const createdResourceIds: string[] = [];

function trackedSubject(): string {
  const id = subjectId();

  createdResourceIds.push(id);

  return id;
}

async function createBusinessRow(
  tx: Prisma.TransactionClient,
  identifier: string,
): Promise<void> {
  await tx.verification.create({
    data: {
      id: identifier,
      identifier,
      value: "audit-platform-fixture",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
}

async function businessRowExists(identifier: string): Promise<boolean> {
  return (
    (await database.verification.findUnique({ where: { id: identifier } })) !==
    null
  );
}

async function recordsFor(resourceId: string) {
  return database.auditRecord.findMany({
    where: { resourceId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
}

const actor = userAuditActor("audit-platform-actor", "audit-platform-session");

beforeAll(() => {
  assertTestDatabase();
});

afterAll(async () => {
  if (createdResourceIds.length > 0) {
    await database.auditRecord.deleteMany({
      where: { resourceId: { in: createdResourceIds } },
    });
    await database.verification.deleteMany({
      where: { id: { in: createdResourceIds } },
    });
  }

  await database.$disconnect();
});

describe("transactional append", () => {
  it("commits the business row and the audit record together", async () => {
    const resourceId = trackedSubject();

    await database.$transaction(async (tx) => {
      await createBusinessRow(tx, resourceId);
      await appendAuditRecord(tx, subjectChanged, {
        actor,
        resourceId,
        result: AUDIT_RESULT.SUCCEEDED,
        metadata: { scope: "all" },
      });
    });

    expect(await businessRowExists(resourceId)).toBe(true);
    expect(await recordsFor(resourceId)).toHaveLength(1);
  });

  it("removes both when the transaction rolls back", async () => {
    const resourceId = trackedSubject();

    await expect(
      database.$transaction(async (tx) => {
        await createBusinessRow(tx, resourceId);
        await appendAuditRecord(tx, subjectChanged, {
          actor,
          resourceId,
          result: AUDIT_RESULT.SUCCEEDED,
          metadata: { scope: "all" },
        });

        throw new Error("the business change failed after the audit write");
      }),
    ).rejects.toThrow("the business change failed");

    expect(await businessRowExists(resourceId)).toBe(false);
    expect(await recordsFor(resourceId)).toHaveLength(0);
  });

  it("fails the transaction when the audit record is refused", async () => {
    const resourceId = trackedSubject();

    await expect(
      database.$transaction(async (tx) => {
        await createBusinessRow(tx, resourceId);
        await appendAuditRecord(tx, subjectChanged, {
          actor,
          resourceId,
          result: AUDIT_RESULT.SUCCEEDED,
          metadata: { scope: "everything" } as never,
        });
      }),
    ).rejects.toThrow(ValidationError);

    // The change is gone with it. This is the point of the transactional writer:
    // an unauditable change does not happen.
    expect(await businessRowExists(resourceId)).toBe(false);
    expect(await recordsFor(resourceId)).toHaveLength(0);
  });

  it("is invisible to another connection until the commit", async () => {
    const resourceId = trackedSubject();
    let visibleDuringTransaction = true;

    await database.$transaction(async (tx) => {
      await appendAuditRecord(tx, subjectChanged, {
        actor,
        resourceId,
        result: AUDIT_RESULT.SUCCEEDED,
        metadata: { scope: "all" },
      });

      // The singleton is a different connection, so it sees the committed state.
      visibleDuringTransaction = (await recordsFor(resourceId)).length > 0;
    });

    expect(visibleDuringTransaction).toBe(false);
    expect(await recordsFor(resourceId)).toHaveLength(1);
  });

  it("refuses the Prisma singleton, so a write cannot happen beside a change", async () => {
    const resourceId = trackedSubject();

    await expect(
      appendAuditRecord(database, subjectChanged, {
        actor,
        resourceId,
        result: AUDIT_RESULT.SUCCEEDED,
        metadata: { scope: "all" },
      }),
    ).rejects.toThrow(/interactive transaction client/);

    expect(await recordsFor(resourceId)).toHaveLength(0);
  });

  it("produces independent records for concurrent transactions", async () => {
    const resourceId = trackedSubject();

    await Promise.all(
      (["all", "one", "all"] as const).map((scope) =>
        database.$transaction(async (tx) =>
          appendAuditRecord(tx, subjectChanged, {
            actor,
            resourceId,
            result: AUDIT_RESULT.SUCCEEDED,
            metadata: { scope },
          }),
        ),
      ),
    );

    const records = await recordsFor(resourceId);

    // Three appends, three rows: an append never overwrites an existing record.
    expect(records).toHaveLength(3);
    expect(new Set(records.map((record) => record.id)).size).toBe(3);
  });
});

describe("post-commit append", () => {
  it("writes the record and reports success", async () => {
    const resourceId = trackedSubject();

    await expect(
      recordAuditPostCommit(subjectChanged, {
        actor,
        resourceId,
        result: AUDIT_RESULT.SUCCEEDED,
        metadata: { scope: "one" },
      }),
    ).resolves.toBe(true);

    expect(await recordsFor(resourceId)).toHaveLength(1);
  });

  it("reports failure instead of throwing when the store refuses the row", async () => {
    // A resource identifier the column cannot hold. The application would have
    // refused it too, but this exercises the path where the database is the one
    // that says no — which is what a storage failure looks like from here.
    const oversized = "x".repeat(300);

    await expect(
      recordAuditPostCommit(subjectChanged, {
        actor,
        resourceId: oversized,
        result: AUDIT_RESULT.SUCCEEDED,
        metadata: { scope: "one" },
      }),
    ).resolves.toBe(false);
  });

  it("appends rather than replacing when called twice", async () => {
    const resourceId = trackedSubject();

    await recordAuditPostCommit(subjectChanged, {
      actor,
      resourceId,
      result: AUDIT_RESULT.SUCCEEDED,
      metadata: { scope: "all" },
    });
    await recordAuditPostCommit(subjectChanged, {
      actor,
      resourceId,
      result: AUDIT_RESULT.DENIED,
      metadata: { scope: "one" },
    });

    expect(await recordsFor(resourceId)).toHaveLength(2);
  });
});

describe("what is stored", () => {
  it("stores the acting session and never selects it for a reader", async () => {
    const resourceId = trackedSubject();

    await recordAuditPostCommit(subjectChanged, {
      actor,
      resourceId,
      result: AUDIT_RESULT.SUCCEEDED,
      metadata: { scope: "all" },
    });

    const [row] = await recordsFor(resourceId);

    expect(row.actorSessionId).toBe("audit-platform-session");

    const page = await listAuditRecords(catalog, { limit: 50 });
    const record = page.records.find(
      (entry) => entry.resource.id === resourceId,
    );

    expect(record).toBeDefined();
    expect(JSON.stringify(record)).not.toContain("audit-platform-session");
    expect(Object.keys(record?.actor ?? {}).sort()).toEqual(["id", "type"]);
  });

  it("round trips metadata the action declares", async () => {
    const resourceId = trackedSubject();

    await recordAuditPostCommit(subjectChanged, {
      actor,
      resourceId,
      result: AUDIT_RESULT.SUCCEEDED,
      metadata: { scope: "one" },
    });

    const page = await listAuditRecords(catalog, { limit: 50 });

    expect(
      page.records.find((entry) => entry.resource.id === resourceId)?.metadata,
    ).toEqual({ scope: "one" });
  });

  it("withholds metadata that was tampered with in storage", async () => {
    const resourceId = trackedSubject();

    await recordAuditPostCommit(subjectChanged, {
      actor,
      resourceId,
      result: AUDIT_RESULT.SUCCEEDED,
      metadata: { scope: "all" },
    });

    // Written directly, bypassing the platform, the way a data fix or an older
    // code path could have.
    await database.$executeRaw`
      UPDATE "audit_record"
         SET "metadata" = '{"scope":"everything"}'::jsonb
       WHERE "resourceId" = ${resourceId}
    `;

    const page = await listAuditRecords(catalog, { limit: 50 });
    const record = page.records.find(
      (entry) => entry.resource.id === resourceId,
    );

    expect(record).toBeDefined();
    expect(record?.metadata).toBeNull();
    expect(JSON.stringify(record)).not.toContain("everything");
  });

  it("keeps a record whose action the reader's catalog does not know", async () => {
    const resourceId = trackedSubject();

    await recordAuditPostCommit(subjectChanged, {
      actor,
      resourceId,
      result: AUDIT_RESULT.SUCCEEDED,
      metadata: { scope: "all" },
    });

    const page = await listAuditRecords(createAuditCatalog([]), { limit: 50 });
    const record = page.records.find(
      (entry) => entry.resource.id === resourceId,
    );

    expect(record?.action).toBe(ACTION_NAME);
    expect(record?.metadata).toBeNull();
  });
});

describe("database constraints", () => {
  async function insertRaw(
    values: Readonly<{
      actorType: string;
      actorSessionId: string | null;
      action: string;
      resourceType: string;
      requestId: string | null;
    }>,
  ) {
    return database.$executeRaw`
      INSERT INTO "audit_record" (
        "id", "actorType", "actorId", "actorSessionId",
        "action", "resourceType", "resourceId", "result", "requestId"
      ) VALUES (
        ${randomUUID()},
        ${values.actorType}::"audit_actor_type",
        'actor-1',
        ${values.actorSessionId},
        ${values.action},
        ${values.resourceType},
        ${trackedSubject()},
        'succeeded'::"audit_result",
        ${values.requestId}
      )
    `;
  }

  const valid = {
    actorType: "user",
    actorSessionId: "session-1",
    action: ACTION_NAME,
    resourceType: RESOURCE_TYPE,
    requestId: null,
  } as const;

  it("accepts a well-formed row", async () => {
    await expect(insertRaw(valid)).resolves.toBe(1);
  });

  it("refuses a user actor with no session and a system actor with one", async () => {
    await expect(insertRaw({ ...valid, actorSessionId: null })).rejects.toThrow(
      /audit_record_actor_session_presence/,
    );
    await expect(insertRaw({ ...valid, actorType: "system" })).rejects.toThrow(
      /audit_record_actor_session_presence/,
    );
  });

  it("refuses a malformed action name", async () => {
    for (const action of ["identity.user", "Identity.User.Set", "a.b.c.d"]) {
      await expect(insertRaw({ ...valid, action })).rejects.toThrow(
        /audit_record_action_pattern/,
      );
    }
  });

  it("refuses a malformed resource type", async () => {
    await expect(
      insertRaw({ ...valid, resourceType: "testing" }),
    ).rejects.toThrow(/audit_record_resource_type_pattern/);
  });

  it("refuses a request identifier that is not a canonical UUID", async () => {
    await expect(insertRaw({ ...valid, requestId: "req-1" })).rejects.toThrow(
      /audit_record_request_id_canonical/,
    );
  });

  it("refuses metadata beyond the ceiling", async () => {
    const resourceId = trackedSubject();

    await expect(
      database.$executeRaw`
        INSERT INTO "audit_record" (
          "id", "actorType", "actorId", "actorSessionId",
          "action", "resourceType", "resourceId", "result", "metadata"
        ) VALUES (
          ${randomUUID()}, 'user'::"audit_actor_type", 'actor-1', 'session-1',
          ${ACTION_NAME}, ${RESOURCE_TYPE}, ${resourceId},
          'succeeded'::"audit_result",
          ${JSON.stringify({ note: "x".repeat(5000) })}::jsonb
        )
      `,
    ).rejects.toThrow(/audit_record_metadata_bounded/);
  });

  it("has no foreign key to identity or to any business table", async () => {
    const constraints = await database.$queryRaw<
      Array<{ contype: string }>
    >`SELECT contype::text FROM pg_constraint WHERE conrelid = '"audit_record"'::regclass`;

    expect(constraints.map((row) => row.contype)).not.toContain("f");
  });
});

describe("keyset pagination", () => {
  /**
   * Every record shares one timestamp, which is the case the identifier tie
   * breaker exists for: without it the second page could repeat a row from the
   * first, or skip one entirely, and both would be silent.
   */
  const collidingResourceId = subjectId();

  beforeAll(async () => {
    createdResourceIds.push(collidingResourceId);

    const occurredAt = new Date("2026-08-01T00:00:00.000Z");

    for (let index = 0; index < 5; index += 1) {
      await database.$transaction(async (tx) =>
        appendAuditRecord(tx, subjectChanged, {
          actor,
          resourceId: collidingResourceId,
          result: AUDIT_RESULT.SUCCEEDED,
          metadata: { scope: "all" },
          occurredAt,
        }),
      );
    }
  });

  async function collect(limit: number): Promise<readonly string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 20; page += 1) {
      const result = await listAuditRecords(catalog, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });

      seen.push(
        ...result.records
          .filter((record) => record.resource.id === collidingResourceId)
          .map((record) => record.id),
      );

      if (result.nextCursor === null) {
        return seen;
      }

      cursor = result.nextCursor;
    }

    throw new Error("The pagination did not terminate.");
  }

  it("returns each record exactly once across pages", async () => {
    const ids = await collect(2);

    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it("skips nothing when every timestamp is identical", async () => {
    const stored = await recordsFor(collidingResourceId);

    expect(new Set(await collect(2))).toEqual(
      new Set(stored.map((record) => record.id)),
    );
  });

  it("orders newest first, breaking ties by identifier", async () => {
    const page = await listAuditRecords(catalog, { limit: 50 });
    const ordered = page.records.map((record) => [
      record.occurredAt,
      record.id,
    ]);

    for (let index = 1; index < ordered.length; index += 1) {
      const [previousTime, previousId] = ordered[index - 1];
      const [currentTime, currentId] = ordered[index];

      expect(
        previousTime > currentTime ||
          (previousTime === currentTime && previousId > currentId),
      ).toBe(true);
    }
  });

  it("hands back a cursor that names the last record it returned", async () => {
    const first = await listAuditRecords(catalog, { limit: 2 });

    expect(first.nextCursor).not.toBeNull();

    const cursor = decodeAuditCursor(first.nextCursor as string);
    const last = first.records.at(-1);

    expect(cursor.id).toBe(last?.id);
    expect(cursor.occurredAt.toISOString()).toBe(last?.occurredAt);
  });

  it("reports no next page once the trail is exhausted", async () => {
    const page = await listAuditRecords(catalog, { limit: 50 });

    if (page.nextCursor === null) {
      expect(page.nextCursor).toBeNull();

      return;
    }

    // A shared database may hold more than this suite's rows, so the assertion
    // walks to the end rather than assuming one page covers everything.
    let cursor: string | null = page.nextCursor;

    for (let index = 0; index < 50 && cursor !== null; index += 1) {
      const next: Awaited<ReturnType<typeof listAuditRecords>> =
        await listAuditRecords(catalog, { limit: 50, cursor });

      cursor = next.nextCursor;
    }

    expect(cursor).toBeNull();
  });

  it("refuses a malformed cursor", async () => {
    await expect(
      listAuditRecords(catalog, { limit: 10, cursor: "not-a-cursor" }),
    ).rejects.toThrow(ValidationError);
  });
});
