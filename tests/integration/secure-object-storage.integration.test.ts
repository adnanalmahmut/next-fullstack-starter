import { randomBytes } from "node:crypto";

import { loadEnvConfig } from "@next/env";
import { afterAll, describe, expect, it, vi } from "vitest";

loadEnvConfig(process.cwd());

vi.doMock("server-only", () => ({}));

const { database } = await import("@/platform/database/index.server");
const {
  claimCleanupCandidate,
  claimUploadIntent,
  completeUploadIntent,
  expireStorageObject,
  failUploadIntent,
  findCleanupCandidates,
  findStorageObjectById,
  findUploadIntentById,
  insertUploadIntent,
  reclaimUploadIntent,
  releaseUploadIntent,
} = await import("@/platform/storage/storage-repository.server");
const { hashFinalizeToken, createFinalizeToken } =
  await import("@/platform/storage/finalize-token");
const {
  STORAGE_INSPECTION_RESULT,
  STORAGE_OBJECT_STATUS,
  UPLOAD_INTENT_STATUS,
} = await import("@/platform/storage/storage-object");

/**
 * The storage tables against a real PostgreSQL.
 *
 * These are the guarantees no unit test can reach and no object store is needed
 * for: that an object and its intent share a commit, that two finalizations
 * racing on one row produce one winner, that an attempt whose lease was taken
 * away can no longer write, and — the half that is easiest to forget — that the
 * database refuses the rows the application would have refused. Every CHECK in
 * the migration exists because a row could otherwise arrive through psql, a data
 * fix, or a future code path, and each of them is exercised here rather than
 * read.
 *
 * Storage itself is disabled while this runs. Nothing here contacts a provider,
 * which is exactly why it belongs in the default suite: the tables and their
 * constraints are part of the application whether or not a bucket is configured.
 *
 * Every test owns its rows. Cleanup is by identifier, never by truncation, and
 * the suite refuses to run at all unless it is pointed at a local test database.
 */
function assertTestDatabase() {
  expect(process.env.APP_ENV).toBe("test");

  const host = new URL(process.env.DATABASE_URL ?? "postgresql://invalid")
    .hostname;

  expect(["127.0.0.1", "localhost", "::1"]).toContain(host);
}

assertTestDatabase();

/**
 * A key prefix nothing else in the repository uses, so cleanup can find exactly
 * the rows this file created without touching a storage integration run that
 * may be using the same database.
 */
const KEY_PREFIX = "next-fullstack-starter/test/pg-suite";

const createdObjectIds: string[] = [];

function randomSuffix(): string {
  return randomBytes(24).toString("hex");
}

function stagingKey(): string {
  return `${KEY_PREFIX}/staging/${randomSuffix()}`;
}

function objectKey(): string {
  return `${KEY_PREFIX}/objects/${randomSuffix()}`;
}

function quarantineKey(): string {
  return `${KEY_PREFIX}/quarantine/${randomSuffix()}`;
}

const CHECKSUM = "a".repeat(64);

async function createIntent(
  overrides: Partial<Parameters<typeof insertUploadIntent>[0]> = {},
) {
  const created = await insertUploadIntent({
    objectKey: objectKey(),
    stagingKey: stagingKey(),
    finalizeTokenHash: hashFinalizeToken(createFinalizeToken()),
    policyName: "test.fixture",
    declaredExtension: "pdf",
    expectedContentType: "application/pdf",
    expectedSizeBytes: 1024,
    expectedChecksumSha256: CHECKSUM,
    expiresAt: new Date(Date.now() + 900_000),
    ...overrides,
  });

  createdObjectIds.push(created.object.id);

  return created;
}

afterAll(async () => {
  // The intent rows follow their objects through the cascade, so removing the
  // objects this file created removes both. Nothing else is touched.
  await database.storageObject.deleteMany({
    where: { id: { in: createdObjectIds } },
  });
  await database.storageObject.deleteMany({
    where: { objectKey: { startsWith: KEY_PREFIX } },
  });
});

describe("creating an upload intent", () => {
  it("writes the object and the intent in one commit", async () => {
    const { object, intent } = await createIntent();

    expect(object.status).toBe(STORAGE_OBJECT_STATUS.PENDING);
    expect(intent.status).toBe(UPLOAD_INTENT_STATUS.PENDING);
    expect(intent.objectId).toBe(object.id);
    expect(intent.version).toBe(1);

    await expect(findUploadIntentById(intent.id)).resolves.toMatchObject({
      id: intent.id,
      objectId: object.id,
    });
  });

  it("persists what the client declared, and nothing more", async () => {
    const { intent } = await createIntent();

    expect(intent.expectedContentType).toBe("application/pdf");
    expect(intent.declaredExtension).toBe("pdf");
    expect(intent.expectedSizeBytes).toBe(BigInt(1024));
    expect(intent.expectedChecksumSha256).toBe(CHECKSUM);
    expect(intent.policyName).toBe("test.fixture");

    // No column exists for a filename, a path, a user, or a session, so there
    // is nothing to assert the absence of by value — the schema is the
    // assertion. What can be checked is that nothing arrived under another
    // name.
    const row = await database.storageUploadIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });

    expect(Object.keys(row).sort()).toEqual([
      "createdAt",
      "declaredExtension",
      "expectedChecksumSha256",
      "expectedContentType",
      "expectedSizeBytes",
      "expiresAt",
      "failureReason",
      "finalizeLeaseExpiresAt",
      "finalizeLeaseTokenHash",
      "finalizeTokenHash",
      "finalizedAt",
      "id",
      "objectId",
      "policyName",
      "stagingKey",
      "status",
      "updatedAt",
      "version",
    ]);
  });

  it("stores the hash of the finalize token and never the token", async () => {
    const token = createFinalizeToken();
    const { intent } = await createIntent({
      finalizeTokenHash: hashFinalizeToken(token),
    });

    expect(intent.finalizeTokenHash).toBe(hashFinalizeToken(token));
    expect(intent.finalizeTokenHash).not.toBe(token);

    const serialized = JSON.stringify(
      await database.storageUploadIntent.findUniqueOrThrow({
        where: { id: intent.id },
      }),
      (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
    );

    expect(serialized).not.toContain(token);
  });

  it("leaves no object row behind when the intent cannot be written", async () => {
    const shared = stagingKey();

    await createIntent({ stagingKey: shared });

    const before = await database.storageObject.count({
      where: { objectKey: { startsWith: KEY_PREFIX } },
    });

    // The staging key is unique, so the second insert fails — inside the same
    // transaction that created the object, which is the point: an object with
    // no intent could never be finalized and would never expire.
    await expect(createIntent({ stagingKey: shared })).rejects.toThrow();

    await expect(
      database.storageObject.count({
        where: { objectKey: { startsWith: KEY_PREFIX } },
      }),
    ).resolves.toBe(before);
  });

  it("refuses two objects at one key", async () => {
    const shared = objectKey();

    await createIntent({ objectKey: shared });

    await expect(createIntent({ objectKey: shared })).rejects.toThrow();
  });
});

describe("the database refuses what the application would refuse", () => {
  it("refuses a key with a traversal sequence", async () => {
    await expect(
      database.storageObject.create({
        data: { objectKey: `${KEY_PREFIX}/objects/../../etc/passwd` },
      }),
    ).rejects.toThrow();
  });

  it("refuses an object key outside the final and quarantine namespaces", async () => {
    await expect(
      database.storageObject.create({
        data: { objectKey: `${KEY_PREFIX}/staging/${randomSuffix()}` },
      }),
    ).rejects.toThrow();
  });

  it("refuses a staging key outside the staging namespace", async () => {
    await expect(createIntent({ stagingKey: objectKey() })).rejects.toThrow();
  });

  it("refuses a checksum that is not canonical", async () => {
    await expect(
      createIntent({ expectedChecksumSha256: "A".repeat(64) }),
    ).rejects.toThrow();
    await expect(
      createIntent({ expectedChecksumSha256: "a".repeat(63) }),
    ).rejects.toThrow();
  });

  it("refuses a declared size that is not positive", async () => {
    await expect(createIntent({ expectedSizeBytes: 0 })).rejects.toThrow();
  });

  it("refuses an expiry that is not after creation", async () => {
    await expect(
      createIntent({ expiresAt: new Date(Date.now() - 900_000) }),
    ).rejects.toThrow();
  });

  it("refuses a policy name that is not <owner>.<purpose>", async () => {
    await expect(createIntent({ policyName: "fixture" })).rejects.toThrow();
    await expect(
      createIntent({ policyName: "Test.Fixture" }),
    ).rejects.toThrow();
  });

  it("refuses an extension that carries a dot or an uppercase letter", async () => {
    await expect(createIntent({ declaredExtension: ".pdf" })).rejects.toThrow();
    await expect(createIntent({ declaredExtension: "PDF" })).rejects.toThrow();
  });

  it("refuses a media type that is not a media type", async () => {
    await expect(
      createIntent({ expectedContentType: "application-pdf" }),
    ).rejects.toThrow();
  });

  it("refuses half a lease", async () => {
    const { intent } = await createIntent();

    await expect(
      database.storageUploadIntent.update({
        where: { id: intent.id },
        data: { finalizeLeaseTokenHash: "0".repeat(64) },
      }),
    ).rejects.toThrow();
  });

  it("refuses a finalizing intent with no lease", async () => {
    const { intent } = await createIntent();

    await expect(
      database.storageUploadIntent.update({
        where: { id: intent.id },
        data: { status: "FINALIZING" },
      }),
    ).rejects.toThrow();
  });

  it("refuses a finalized intent that still holds a lease", async () => {
    const { intent } = await createIntent();

    await expect(
      database.storageUploadIntent.update({
        where: { id: intent.id },
        data: {
          status: "FINALIZED",
          finalizedAt: new Date(),
          finalizeLeaseTokenHash: "0".repeat(64),
          finalizeLeaseExpiresAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses a ready object with no verified metadata", async () => {
    const { object } = await createIntent();

    await expect(
      database.storageObject.update({
        where: { id: object.id },
        data: { status: "READY", readyAt: new Date() },
      }),
    ).rejects.toThrow();
  });

  it("refuses a ready object that an inspector quarantined", async () => {
    const { object } = await createIntent();

    await expect(
      database.storageObject.update({
        where: { id: object.id },
        data: {
          status: "READY",
          contentType: "application/pdf",
          sizeBytes: BigInt(1024),
          checksumSha256: CHECKSUM,
          readyAt: new Date(),
          inspectionResult: "QUARANTINED",
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses a quarantined object still sitting at a final key", async () => {
    const { object } = await createIntent();

    await expect(
      database.storageObject.update({
        where: { id: object.id },
        data: {
          status: "QUARANTINED",
          quarantinedAt: new Date(),
          inspectionResult: "QUARANTINED",
          inspectionReason: "signature-match",
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses a pending object that claims to be ready or withheld", async () => {
    const { object } = await createIntent();

    await expect(
      database.storageObject.update({
        where: { id: object.id },
        data: { readyAt: new Date() },
      }),
    ).rejects.toThrow();
  });

  it("refuses a version that is not positive", async () => {
    const { intent } = await createIntent();

    await expect(
      database.storageUploadIntent.update({
        where: { id: intent.id },
        data: { version: 0 },
      }),
    ).rejects.toThrow();
  });
});

describe("claiming a finalization", () => {
  it("takes the lease and bumps the version", async () => {
    const { intent } = await createIntent();
    const now = new Date();

    const claimed = await claimUploadIntent({
      intentId: intent.id,
      expectedVersion: intent.version,
      leaseTokenHash: "1".repeat(64),
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      now,
    });

    expect(claimed).toMatchObject({
      status: UPLOAD_INTENT_STATUS.FINALIZING,
      finalizeLeaseTokenHash: "1".repeat(64),
      version: intent.version + 1,
    });
  });

  it("lets exactly one of two concurrent attempts win", async () => {
    const { intent } = await createIntent();
    const now = new Date();

    const attempt = (hash: string) =>
      claimUploadIntent({
        intentId: intent.id,
        expectedVersion: intent.version,
        leaseTokenHash: hash,
        leaseExpiresAt: new Date(now.getTime() + 30_000),
        now,
      });

    const [first, second] = await Promise.all([
      attempt("1".repeat(64)),
      attempt("2".repeat(64)),
    ]);

    expect([first, second].filter((result) => result !== null)).toHaveLength(1);
  });

  it("refuses to claim an intent that has expired", async () => {
    const { intent } = await createIntent();

    await expect(
      claimUploadIntent({
        intentId: intent.id,
        expectedVersion: intent.version,
        leaseTokenHash: "1".repeat(64),
        leaseExpiresAt: new Date(),
        now: new Date(Date.now() + 3_600_000),
      }),
    ).resolves.toBeNull();
  });

  it("refuses to reclaim a lease that is still live", async () => {
    const { intent } = await createIntent();
    const now = new Date();

    const claimed = await claimUploadIntent({
      intentId: intent.id,
      expectedVersion: intent.version,
      leaseTokenHash: "1".repeat(64),
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      now,
    });

    await expect(
      reclaimUploadIntent({
        intentId: intent.id,
        expectedVersion: claimed?.version ?? 0,
        leaseTokenHash: "2".repeat(64),
        leaseExpiresAt: new Date(now.getTime() + 30_000),
        now,
      }),
    ).resolves.toBeNull();
  });

  it("reclaims a lease whose holder never came back, and locks that holder out", async () => {
    const { intent, object } = await createIntent();
    const now = new Date();

    const first = await claimUploadIntent({
      intentId: intent.id,
      expectedVersion: intent.version,
      leaseTokenHash: "1".repeat(64),
      leaseExpiresAt: new Date(now.getTime() - 1_000),
      now,
    });

    const second = await reclaimUploadIntent({
      intentId: intent.id,
      expectedVersion: first?.version ?? 0,
      leaseTokenHash: "2".repeat(64),
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      now,
    });

    expect(second?.finalizeLeaseTokenHash).toBe("2".repeat(64));

    // The original holder comes back and tries to finish. It still carries the
    // version and the lease token it claimed with, and both are stale, so it
    // writes nothing at all — which is the entire reason the lease is a token
    // and the row carries a version.
    await expect(
      completeUploadIntent({
        intentId: intent.id,
        objectId: object.id,
        expectedVersion: first?.version ?? 0,
        leaseTokenHash: "1".repeat(64),
        contentType: "application/pdf",
        sizeBytes: 1024,
        checksumSha256: CHECKSUM,
        etag: "abc",
        inspection: STORAGE_INSPECTION_RESULT.NOT_CONFIGURED,
        now,
      }),
    ).resolves.toBeNull();

    await expect(findStorageObjectById(object.id)).resolves.toMatchObject({
      status: STORAGE_OBJECT_STATUS.PENDING,
    });
  });
});

describe("completing a finalization", () => {
  async function claimed() {
    const { intent, object } = await createIntent();
    const now = new Date();

    const withLease = await claimUploadIntent({
      intentId: intent.id,
      expectedVersion: intent.version,
      leaseTokenHash: "1".repeat(64),
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      now,
    });

    return { intent: withLease!, object, now };
  }

  it("moves both rows together", async () => {
    const { intent, object, now } = await claimed();

    const completed = await completeUploadIntent({
      intentId: intent.id,
      objectId: object.id,
      expectedVersion: intent.version,
      leaseTokenHash: "1".repeat(64),
      contentType: "application/pdf",
      sizeBytes: 1024,
      checksumSha256: CHECKSUM,
      etag: "an-entity-tag",
      inspection: STORAGE_INSPECTION_RESULT.CLEAN,
      now,
    });

    expect(completed?.object).toMatchObject({
      status: STORAGE_OBJECT_STATUS.READY,
      contentType: "application/pdf",
      sizeBytes: BigInt(1024),
      checksumSha256: CHECKSUM,
      inspectionResult: STORAGE_INSPECTION_RESULT.CLEAN,
    });
    expect(completed?.intent).toMatchObject({
      status: UPLOAD_INTENT_STATUS.FINALIZED,
      finalizeLeaseTokenHash: null,
      finalizeLeaseExpiresAt: null,
    });
  });

  it("writes nothing when the lease token is wrong", async () => {
    const { intent, object, now } = await claimed();

    await expect(
      completeUploadIntent({
        intentId: intent.id,
        objectId: object.id,
        expectedVersion: intent.version,
        leaseTokenHash: "9".repeat(64),
        contentType: "application/pdf",
        sizeBytes: 1024,
        checksumSha256: CHECKSUM,
        etag: "an-entity-tag",
        inspection: STORAGE_INSPECTION_RESULT.NOT_CONFIGURED,
        now,
      }),
    ).resolves.toBeNull();

    await expect(findStorageObjectById(object.id)).resolves.toMatchObject({
      status: STORAGE_OBJECT_STATUS.PENDING,
    });
  });

  it("records a rejection without promoting anything", async () => {
    const { intent, object, now } = await claimed();

    await expect(
      failUploadIntent({
        intentId: intent.id,
        objectId: object.id,
        expectedVersion: intent.version,
        leaseTokenHash: "1".repeat(64),
        intentStatus: UPLOAD_INTENT_STATUS.REJECTED,
        objectStatus: STORAGE_OBJECT_STATUS.REJECTED,
        reason: "checksum-mismatch",
        inspection: null,
        now,
      }),
    ).resolves.toBe(true);

    await expect(findStorageObjectById(object.id)).resolves.toMatchObject({
      status: STORAGE_OBJECT_STATUS.REJECTED,
      readyAt: null,
    });
    await expect(findUploadIntentById(intent.id)).resolves.toMatchObject({
      status: UPLOAD_INTENT_STATUS.REJECTED,
      failureReason: "checksum-mismatch",
    });
  });

  it("moves a quarantined object to the quarantine namespace", async () => {
    const { intent, object, now } = await claimed();
    const withheldKey = quarantineKey();

    await expect(
      failUploadIntent({
        intentId: intent.id,
        objectId: object.id,
        expectedVersion: intent.version,
        leaseTokenHash: "1".repeat(64),
        intentStatus: UPLOAD_INTENT_STATUS.QUARANTINED,
        objectStatus: STORAGE_OBJECT_STATUS.QUARANTINED,
        reason: "signature-match",
        inspection: STORAGE_INSPECTION_RESULT.QUARANTINED,
        quarantineKey: withheldKey,
        now,
      }),
    ).resolves.toBe(true);

    await expect(findStorageObjectById(object.id)).resolves.toMatchObject({
      status: STORAGE_OBJECT_STATUS.QUARANTINED,
      objectKey: withheldKey,
      inspectionResult: STORAGE_INSPECTION_RESULT.QUARANTINED,
      inspectionReason: "signature-match",
      readyAt: null,
    });
  });

  it("puts a released intent back where a retry can find it", async () => {
    const { intent, now } = await claimed();

    await expect(
      releaseUploadIntent({
        intentId: intent.id,
        expectedVersion: intent.version,
        leaseTokenHash: "1".repeat(64),
      }),
    ).resolves.toBe(true);

    const released = await findUploadIntentById(intent.id);

    expect(released).toMatchObject({
      status: UPLOAD_INTENT_STATUS.PENDING,
      finalizeLeaseTokenHash: null,
    });
    // The expiry is untouched: a failing provider does not buy the client more
    // time than the intent was issued for.
    expect(released?.expiresAt.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("the cleanup query", () => {
  it("finds an expired pending intent and stops at the limit", async () => {
    const created = await Promise.all([createIntent(), createIntent()]);

    for (const { intent } of created) {
      const row = await database.storageUploadIntent.findUniqueOrThrow({
        where: { id: intent.id },
        select: { createdAt: true },
      });

      await database.storageUploadIntent.update({
        where: { id: intent.id },
        data: { expiresAt: new Date(row.createdAt.getTime() + 1) },
      });
    }

    const candidates = await findCleanupCandidates({
      now: new Date(),
      limit: 1,
    });

    expect(candidates).toHaveLength(1);
  });

  it("never returns an intent that is still alive", async () => {
    const { intent } = await createIntent();

    const candidates = await findCleanupCandidates({
      now: new Date(),
      limit: 100,
    });

    expect(candidates.map((candidate) => candidate.intent.id)).not.toContain(
      intent.id,
    );
  });

  it("never returns a finalized intent, however old", async () => {
    const { intent, object } = await createIntent();
    const now = new Date();

    const withLease = await claimUploadIntent({
      intentId: intent.id,
      expectedVersion: intent.version,
      leaseTokenHash: "1".repeat(64),
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      now,
    });

    await completeUploadIntent({
      intentId: intent.id,
      objectId: object.id,
      expectedVersion: withLease?.version ?? 0,
      leaseTokenHash: "1".repeat(64),
      contentType: "application/pdf",
      sizeBytes: 1024,
      checksumSha256: CHECKSUM,
      etag: "an-entity-tag",
      inspection: STORAGE_INSPECTION_RESULT.NOT_CONFIGURED,
      now,
    });

    const row = await database.storageUploadIntent.findUniqueOrThrow({
      where: { id: intent.id },
      select: { createdAt: true },
    });

    await database.storageUploadIntent.update({
      where: { id: intent.id },
      data: { expiresAt: new Date(row.createdAt.getTime() + 1) },
    });

    const candidates = await findCleanupCandidates({
      now: new Date(),
      limit: 100,
    });

    expect(candidates.map((candidate) => candidate.intent.id)).not.toContain(
      intent.id,
    );
  });

  it("gives one candidate to one pass", async () => {
    const { intent } = await createIntent();
    const row = await database.storageUploadIntent.findUniqueOrThrow({
      where: { id: intent.id },
      select: { createdAt: true },
    });

    await database.storageUploadIntent.update({
      where: { id: intent.id },
      data: { expiresAt: new Date(row.createdAt.getTime() + 1) },
    });

    const now = new Date();
    const take = () =>
      claimCleanupCandidate({
        intentId: intent.id,
        expectedVersion: intent.version,
        expectedStatus: UPLOAD_INTENT_STATUS.PENDING,
        now,
      });

    const [first, second] = await Promise.all([take(), take()]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("expires the object only while it is still undecided", async () => {
    const { intent, object } = await createIntent();
    const now = new Date();

    const withLease = await claimUploadIntent({
      intentId: intent.id,
      expectedVersion: intent.version,
      leaseTokenHash: "1".repeat(64),
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      now,
    });

    await completeUploadIntent({
      intentId: intent.id,
      objectId: object.id,
      expectedVersion: withLease?.version ?? 0,
      leaseTokenHash: "1".repeat(64),
      contentType: "application/pdf",
      sizeBytes: 1024,
      checksumSha256: CHECKSUM,
      etag: "an-entity-tag",
      inspection: STORAGE_INSPECTION_RESULT.NOT_CONFIGURED,
      now,
    });

    // A cleanup pass that started before the finalization committed reaches
    // this line afterwards. The object is ready now, and must stay that way.
    await expireStorageObject(object.id);

    await expect(findStorageObjectById(object.id)).resolves.toMatchObject({
      status: STORAGE_OBJECT_STATUS.READY,
    });
  });
});
