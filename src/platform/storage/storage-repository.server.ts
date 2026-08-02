import "server-only";

import {
  StorageInspectionResult as StoredInspectionResult,
  StorageObjectStatus as StoredObjectStatus,
  StorageUploadIntentStatus as StoredIntentStatus,
} from "@/generated/prisma/enums";
import { database } from "@/platform/database/index.server";

import {
  STORAGE_INSPECTION_RESULT,
  STORAGE_OBJECT_STATUS,
  UPLOAD_INTENT_STATUS,
  type StorageInspectionResult,
  type StorageObjectStatus,
  type StoredStorageObject,
  type StoredUploadIntent,
  type UploadIntentStatus,
} from "./storage-object";

/**
 * The only data-access point for object storage.
 *
 * Two properties are worth stating rather than inferring. First, this file
 * never talks to the provider: it has no import of the adapter, no S3 client,
 * and no network call, which is what makes "no provider request inside a
 * database transaction" structurally true rather than a rule to review for. A
 * transaction that waited on a bucket would hold row locks for the length of an
 * HTTP round trip, and a bucket that timed out would hold them for the length of
 * a timeout.
 *
 * Second, every state change here is conditional. Nothing is written by "load,
 * decide, save": a claim, a completion, and a cleanup each carry the status and
 * the version they expected, and `updateMany` reports how many rows actually
 * matched. That is what makes two concurrent finalizations produce one winner
 * with PostgreSQL as the only coordinator — no Redis lock, no advisory lock, no
 * distributed anything.
 *
 * It is not exported from `index.server.ts`. Handing out the repository would
 * let a caller move an object to `ready` without the verification that is
 * supposed to precede it.
 */
const STORED_OBJECT_STATUS = {
  [STORAGE_OBJECT_STATUS.PENDING]: StoredObjectStatus.PENDING,
  [STORAGE_OBJECT_STATUS.READY]: StoredObjectStatus.READY,
  [STORAGE_OBJECT_STATUS.QUARANTINED]: StoredObjectStatus.QUARANTINED,
  [STORAGE_OBJECT_STATUS.REJECTED]: StoredObjectStatus.REJECTED,
  [STORAGE_OBJECT_STATUS.EXPIRED]: StoredObjectStatus.EXPIRED,
} as const satisfies Readonly<Record<StorageObjectStatus, StoredObjectStatus>>;

const OBJECT_STATUS_BY_STORED = {
  [StoredObjectStatus.PENDING]: STORAGE_OBJECT_STATUS.PENDING,
  [StoredObjectStatus.READY]: STORAGE_OBJECT_STATUS.READY,
  [StoredObjectStatus.QUARANTINED]: STORAGE_OBJECT_STATUS.QUARANTINED,
  [StoredObjectStatus.REJECTED]: STORAGE_OBJECT_STATUS.REJECTED,
  [StoredObjectStatus.EXPIRED]: STORAGE_OBJECT_STATUS.EXPIRED,
} as const satisfies Readonly<Record<StoredObjectStatus, StorageObjectStatus>>;

const STORED_INTENT_STATUS = {
  [UPLOAD_INTENT_STATUS.PENDING]: StoredIntentStatus.PENDING,
  [UPLOAD_INTENT_STATUS.FINALIZING]: StoredIntentStatus.FINALIZING,
  [UPLOAD_INTENT_STATUS.FINALIZED]: StoredIntentStatus.FINALIZED,
  [UPLOAD_INTENT_STATUS.QUARANTINED]: StoredIntentStatus.QUARANTINED,
  [UPLOAD_INTENT_STATUS.REJECTED]: StoredIntentStatus.REJECTED,
  [UPLOAD_INTENT_STATUS.EXPIRED]: StoredIntentStatus.EXPIRED,
} as const satisfies Readonly<Record<UploadIntentStatus, StoredIntentStatus>>;

const INTENT_STATUS_BY_STORED = {
  [StoredIntentStatus.PENDING]: UPLOAD_INTENT_STATUS.PENDING,
  [StoredIntentStatus.FINALIZING]: UPLOAD_INTENT_STATUS.FINALIZING,
  [StoredIntentStatus.FINALIZED]: UPLOAD_INTENT_STATUS.FINALIZED,
  [StoredIntentStatus.QUARANTINED]: UPLOAD_INTENT_STATUS.QUARANTINED,
  [StoredIntentStatus.REJECTED]: UPLOAD_INTENT_STATUS.REJECTED,
  [StoredIntentStatus.EXPIRED]: UPLOAD_INTENT_STATUS.EXPIRED,
} as const satisfies Readonly<Record<StoredIntentStatus, UploadIntentStatus>>;

const STORED_INSPECTION_RESULT = {
  [STORAGE_INSPECTION_RESULT.NOT_CONFIGURED]:
    StoredInspectionResult.NOT_CONFIGURED,
  [STORAGE_INSPECTION_RESULT.CLEAN]: StoredInspectionResult.CLEAN,
  [STORAGE_INSPECTION_RESULT.QUARANTINED]: StoredInspectionResult.QUARANTINED,
} as const satisfies Readonly<
  Record<StorageInspectionResult, StoredInspectionResult>
>;

const INSPECTION_RESULT_BY_STORED = {
  [StoredInspectionResult.NOT_CONFIGURED]:
    STORAGE_INSPECTION_RESULT.NOT_CONFIGURED,
  [StoredInspectionResult.CLEAN]: STORAGE_INSPECTION_RESULT.CLEAN,
  [StoredInspectionResult.QUARANTINED]: STORAGE_INSPECTION_RESULT.QUARANTINED,
} as const satisfies Readonly<
  Record<StoredInspectionResult, StorageInspectionResult>
>;

type ObjectRow = Readonly<{
  id: string;
  status: StoredObjectStatus;
  objectKey: string;
  contentType: string | null;
  sizeBytes: bigint | null;
  checksumSha256: string | null;
  etag: string | null;
  inspectionResult: StoredInspectionResult | null;
  inspectionReason: string | null;
  readyAt: Date | null;
  quarantinedAt: Date | null;
  createdAt: Date;
}>;

type IntentRow = Readonly<{
  id: string;
  objectId: string;
  status: StoredIntentStatus;
  stagingKey: string;
  finalizeTokenHash: string;
  policyName: string;
  declaredExtension: string;
  expectedContentType: string;
  expectedSizeBytes: bigint;
  expectedChecksumSha256: string;
  expiresAt: Date;
  finalizeLeaseTokenHash: string | null;
  finalizeLeaseExpiresAt: Date | null;
  finalizedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  version: number;
}>;

const OBJECT_SELECTION = {
  id: true,
  status: true,
  objectKey: true,
  contentType: true,
  sizeBytes: true,
  checksumSha256: true,
  etag: true,
  inspectionResult: true,
  inspectionReason: true,
  readyAt: true,
  quarantinedAt: true,
  createdAt: true,
} as const;

/**
 * `finalizeTokenHash` is selected; the raw token is not stored anywhere, so
 * there is nothing to withhold. The lease hash is selected for the same reason:
 * a completion has to prove it still holds the lease it took.
 */
const INTENT_SELECTION = {
  id: true,
  objectId: true,
  status: true,
  stagingKey: true,
  finalizeTokenHash: true,
  policyName: true,
  declaredExtension: true,
  expectedContentType: true,
  expectedSizeBytes: true,
  expectedChecksumSha256: true,
  expiresAt: true,
  finalizeLeaseTokenHash: true,
  finalizeLeaseExpiresAt: true,
  finalizedAt: true,
  failureReason: true,
  createdAt: true,
  version: true,
} as const;

function toStoredObject(row: ObjectRow): StoredStorageObject {
  return {
    id: row.id,
    status: OBJECT_STATUS_BY_STORED[row.status],
    objectKey: row.objectKey,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256,
    etag: row.etag,
    inspectionResult:
      row.inspectionResult === null
        ? null
        : INSPECTION_RESULT_BY_STORED[row.inspectionResult],
    inspectionReason: row.inspectionReason,
    readyAt: row.readyAt,
    quarantinedAt: row.quarantinedAt,
    createdAt: row.createdAt,
  };
}

function toStoredIntent(row: IntentRow): StoredUploadIntent {
  return {
    id: row.id,
    objectId: row.objectId,
    status: INTENT_STATUS_BY_STORED[row.status],
    stagingKey: row.stagingKey,
    finalizeTokenHash: row.finalizeTokenHash,
    policyName: row.policyName,
    declaredExtension: row.declaredExtension,
    expectedContentType: row.expectedContentType,
    expectedSizeBytes: row.expectedSizeBytes,
    expectedChecksumSha256: row.expectedChecksumSha256,
    expiresAt: row.expiresAt,
    finalizeLeaseTokenHash: row.finalizeLeaseTokenHash,
    finalizeLeaseExpiresAt: row.finalizeLeaseExpiresAt,
    finalizedAt: row.finalizedAt,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    version: row.version,
  };
}

export type CreateUploadIntentRow = Readonly<{
  objectKey: string;
  stagingKey: string;
  finalizeTokenHash: string;
  policyName: string;
  declaredExtension: string;
  expectedContentType: string;
  expectedSizeBytes: number;
  expectedChecksumSha256: string;
  expiresAt: Date;
}>;

/**
 * Creates the object and its intent together.
 *
 * In one transaction, because an object with no intent is unreachable — nothing
 * can ever finalize it — and an intent with no object is a foreign key that does
 * not resolve. Neither is a state worth having code that handles.
 */
export async function insertUploadIntent(
  input: CreateUploadIntentRow,
): Promise<{ object: StoredStorageObject; intent: StoredUploadIntent }> {
  return database.$transaction(async (tx) => {
    const object = await tx.storageObject.create({
      data: {
        status: StoredObjectStatus.PENDING,
        objectKey: input.objectKey,
      },
      select: OBJECT_SELECTION,
    });

    const intent = await tx.storageUploadIntent.create({
      data: {
        objectId: object.id,
        status: StoredIntentStatus.PENDING,
        stagingKey: input.stagingKey,
        finalizeTokenHash: input.finalizeTokenHash,
        policyName: input.policyName,
        declaredExtension: input.declaredExtension,
        expectedContentType: input.expectedContentType,
        expectedSizeBytes: BigInt(input.expectedSizeBytes),
        expectedChecksumSha256: input.expectedChecksumSha256,
        expiresAt: input.expiresAt,
      },
      select: INTENT_SELECTION,
    });

    return { object: toStoredObject(object), intent: toStoredIntent(intent) };
  });
}

export async function findUploadIntentById(
  intentId: string,
): Promise<StoredUploadIntent | null> {
  const row = await database.storageUploadIntent.findUnique({
    where: { id: intentId },
    select: INTENT_SELECTION,
  });

  return row === null ? null : toStoredIntent(row);
}

export async function findStorageObjectById(
  objectId: string,
): Promise<StoredStorageObject | null> {
  const row = await database.storageObject.findUnique({
    where: { id: objectId },
    select: OBJECT_SELECTION,
  });

  return row === null ? null : toStoredObject(row);
}

/**
 * Takes the finalization lease, or reports that somebody else has it.
 *
 * The whole claim is one conditional update. The `where` names the status and
 * the version the caller read, so two attempts that both read version 1 produce
 * one update of one row and one update of none — the loser is told by a count,
 * not by an exception, and never by a second row.
 *
 * `expiresAt` is part of the condition rather than checked beforehand, because
 * an intent can expire between the read and the claim, and a claim on an expired
 * intent would start a provider round trip for an upload that is already dead.
 */
export async function claimUploadIntent(input: {
  intentId: string;
  expectedVersion: number;
  leaseTokenHash: string;
  leaseExpiresAt: Date;
  now: Date;
}): Promise<StoredUploadIntent | null> {
  const claimed = await database.storageUploadIntent.updateMany({
    where: {
      id: input.intentId,
      version: input.expectedVersion,
      status: StoredIntentStatus.PENDING,
      expiresAt: { gt: input.now },
    },
    data: {
      status: StoredIntentStatus.FINALIZING,
      finalizeLeaseTokenHash: input.leaseTokenHash,
      finalizeLeaseExpiresAt: input.leaseExpiresAt,
      version: { increment: 1 },
    },
  });

  if (claimed.count === 0) {
    return null;
  }

  return findUploadIntentById(input.intentId);
}

/**
 * Takes over a lease whose holder never came back.
 *
 * The condition is the same shape as a first claim, with one addition: the
 * previous lease must already have expired. The version increments here too,
 * which is what stops the original holder from completing afterwards — it still
 * carries the version it claimed with, and every completion checks it.
 */
export async function reclaimUploadIntent(input: {
  intentId: string;
  expectedVersion: number;
  leaseTokenHash: string;
  leaseExpiresAt: Date;
  now: Date;
}): Promise<StoredUploadIntent | null> {
  const claimed = await database.storageUploadIntent.updateMany({
    where: {
      id: input.intentId,
      version: input.expectedVersion,
      status: StoredIntentStatus.FINALIZING,
      finalizeLeaseExpiresAt: { lt: input.now },
      expiresAt: { gt: input.now },
    },
    data: {
      finalizeLeaseTokenHash: input.leaseTokenHash,
      finalizeLeaseExpiresAt: input.leaseExpiresAt,
      version: { increment: 1 },
    },
  });

  if (claimed.count === 0) {
    return null;
  }

  return findUploadIntentById(input.intentId);
}

/**
 * Commits a successful finalization.
 *
 * Short, and entered only after every provider call has already returned. Both
 * rows move together: an object that is `ready` while its intent is still
 * `finalizing` would be served to callers and cleaned up as abandoned at the
 * same time.
 *
 * The guard is the lease hash *and* the version. An attempt whose lease was
 * reclaimed while it was copying fails here and writes nothing — which is the
 * whole reason the lease is a token rather than a boolean.
 */
export async function completeUploadIntent(input: {
  intentId: string;
  objectId: string;
  expectedVersion: number;
  leaseTokenHash: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  etag: string;
  inspection: StorageInspectionResult;
  now: Date;
}): Promise<{
  object: StoredStorageObject;
  intent: StoredUploadIntent;
} | null> {
  return database.$transaction(async (tx) => {
    const updated = await tx.storageUploadIntent.updateMany({
      where: {
        id: input.intentId,
        version: input.expectedVersion,
        status: StoredIntentStatus.FINALIZING,
        finalizeLeaseTokenHash: input.leaseTokenHash,
      },
      data: {
        status: StoredIntentStatus.FINALIZED,
        finalizedAt: input.now,
        finalizeLeaseTokenHash: null,
        finalizeLeaseExpiresAt: null,
        version: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      return null;
    }

    await tx.storageObject.update({
      where: { id: input.objectId },
      data: {
        status: StoredObjectStatus.READY,
        contentType: input.contentType,
        sizeBytes: BigInt(input.sizeBytes),
        checksumSha256: input.checksumSha256,
        etag: input.etag,
        inspectionResult: STORED_INSPECTION_RESULT[input.inspection],
        readyAt: input.now,
      },
    });

    const object = await tx.storageObject.findUniqueOrThrow({
      where: { id: input.objectId },
      select: OBJECT_SELECTION,
    });
    const intent = await tx.storageUploadIntent.findUniqueOrThrow({
      where: { id: input.intentId },
      select: INTENT_SELECTION,
    });

    return { object: toStoredObject(object), intent: toStoredIntent(intent) };
  });
}

/**
 * Records that the upload will never become a usable object.
 *
 * Both terminal failures go through here — the bytes did not match, or an
 * inspector withheld the file — because they differ only in which status the
 * two rows take and whether a quarantine key was written.
 */
export async function failUploadIntent(input: {
  intentId: string;
  objectId: string;
  expectedVersion: number;
  leaseTokenHash: string;
  intentStatus:
    | typeof UPLOAD_INTENT_STATUS.REJECTED
    | typeof UPLOAD_INTENT_STATUS.QUARANTINED;
  objectStatus:
    | typeof STORAGE_OBJECT_STATUS.REJECTED
    | typeof STORAGE_OBJECT_STATUS.QUARANTINED;
  reason: string;
  inspection: StorageInspectionResult | null;
  quarantineKey?: string;
  now: Date;
}): Promise<boolean> {
  return database.$transaction(async (tx) => {
    const updated = await tx.storageUploadIntent.updateMany({
      where: {
        id: input.intentId,
        version: input.expectedVersion,
        status: StoredIntentStatus.FINALIZING,
        finalizeLeaseTokenHash: input.leaseTokenHash,
      },
      data: {
        status: STORED_INTENT_STATUS[input.intentStatus],
        failureReason: input.reason,
        finalizeLeaseTokenHash: null,
        finalizeLeaseExpiresAt: null,
        version: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      return false;
    }

    const quarantined =
      input.objectStatus === STORAGE_OBJECT_STATUS.QUARANTINED;

    await tx.storageObject.update({
      where: { id: input.objectId },
      data: {
        status: STORED_OBJECT_STATUS[input.objectStatus],
        ...(input.quarantineKey === undefined
          ? {}
          : { objectKey: input.quarantineKey }),
        ...(input.inspection === null
          ? {}
          : { inspectionResult: STORED_INSPECTION_RESULT[input.inspection] }),
        ...(quarantined
          ? { inspectionReason: input.reason, quarantinedAt: input.now }
          : {}),
      },
    });

    return true;
  });
}

/**
 * Puts a claimed intent back so it can be retried.
 *
 * Used when the provider was unreachable *before* anything was copied: nothing
 * happened, the intent is still within its lifetime, and the client may try
 * again. The expiry is deliberately not extended — a failing provider is not a
 * reason to keep an upload authorization alive longer than it was issued for.
 */
export async function releaseUploadIntent(input: {
  intentId: string;
  expectedVersion: number;
  leaseTokenHash: string;
}): Promise<boolean> {
  const released = await database.storageUploadIntent.updateMany({
    where: {
      id: input.intentId,
      version: input.expectedVersion,
      status: StoredIntentStatus.FINALIZING,
      finalizeLeaseTokenHash: input.leaseTokenHash,
    },
    data: {
      status: StoredIntentStatus.PENDING,
      finalizeLeaseTokenHash: null,
      finalizeLeaseExpiresAt: null,
      version: { increment: 1 },
    },
  });

  return released.count > 0;
}

export type CleanupCandidate = Readonly<{
  intent: StoredUploadIntent;
  object: StoredStorageObject;
}>;

/**
 * The intents a cleanup pass may take, oldest first.
 *
 * Two kinds, and both are already dead rather than merely idle: a `pending`
 * intent past its expiry, which nobody finalized, and a `finalizing` intent
 * whose lease has lapsed *and* whose own lifetime has run out. The second
 * condition on the second kind is what preserves the retry window — while an
 * intent is still alive, a lapsed lease means "somebody else may take over",
 * not "delete this".
 *
 * The ordering is stable and the limit is mandatory upstream, so a pass is
 * bounded work over an indexed range rather than a scan.
 */
export async function findCleanupCandidates(input: {
  now: Date;
  limit: number;
}): Promise<readonly CleanupCandidate[]> {
  const rows = await database.storageUploadIntent.findMany({
    where: {
      expiresAt: { lt: input.now },
      OR: [
        { status: StoredIntentStatus.PENDING },
        {
          status: StoredIntentStatus.FINALIZING,
          finalizeLeaseExpiresAt: { lt: input.now },
        },
      ],
    },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: input.limit,
    select: { ...INTENT_SELECTION, object: { select: OBJECT_SELECTION } },
  });

  return rows.map((row) => ({
    intent: toStoredIntent(row),
    object: toStoredObject(row.object),
  }));
}

/**
 * Takes one candidate for this cleanup pass.
 *
 * Conditional on the version it was read at, so two cleanup passes running at
 * once each get a disjoint set: the second one's update matches nothing and it
 * moves on. A `ready` object is unreachable from here — its intent is
 * `finalized`, and neither branch of the condition admits that status — so a
 * pass that starts while a finalization is committing cannot delete an object
 * that has just become usable.
 */
export async function claimCleanupCandidate(input: {
  intentId: string;
  expectedVersion: number;
  expectedStatus: UploadIntentStatus;
  now: Date;
}): Promise<boolean> {
  const claimed = await database.storageUploadIntent.updateMany({
    where: {
      id: input.intentId,
      version: input.expectedVersion,
      status: STORED_INTENT_STATUS[input.expectedStatus],
      expiresAt: { lt: input.now },
    },
    data: {
      status: StoredIntentStatus.EXPIRED,
      failureReason: "expired",
      finalizeLeaseTokenHash: null,
      finalizeLeaseExpiresAt: null,
      version: { increment: 1 },
    },
  });

  return claimed.count > 0;
}

/**
 * Expires the object behind a cleaned-up intent.
 *
 * Conditional on the object still being pending. An object that reached any
 * other state was decided by a finalization, and a cleanup pass is not entitled
 * to overrule that — which is what keeps a slow pass from expiring an object
 * that became `ready` while it was running.
 */
export async function expireStorageObject(objectId: string): Promise<void> {
  await database.storageObject.updateMany({
    where: { id: objectId, status: StoredObjectStatus.PENDING },
    data: { status: StoredObjectStatus.EXPIRED },
  });
}
