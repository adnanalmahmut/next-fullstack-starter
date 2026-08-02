/**
 * The states an object and an intent move through, and the safe view of an
 * object that leaves the platform.
 *
 * The status values mirror the database enums one for one, and the mapping
 * between the two is exhaustive by type in the repository, so adding a state on
 * either side without mapping it is a compile error rather than a row that
 * cannot be read back.
 */

export const STORAGE_OBJECT_STATUS = {
  PENDING: "pending",
  READY: "ready",
  QUARANTINED: "quarantined",
  REJECTED: "rejected",
  EXPIRED: "expired",
} as const;

export type StorageObjectStatus =
  (typeof STORAGE_OBJECT_STATUS)[keyof typeof STORAGE_OBJECT_STATUS];

export const STORAGE_OBJECT_STATUSES = Object.values(
  STORAGE_OBJECT_STATUS,
) as readonly StorageObjectStatus[];

export const UPLOAD_INTENT_STATUS = {
  PENDING: "pending",
  FINALIZING: "finalizing",
  FINALIZED: "finalized",
  QUARANTINED: "quarantined",
  REJECTED: "rejected",
  EXPIRED: "expired",
} as const;

export type UploadIntentStatus =
  (typeof UPLOAD_INTENT_STATUS)[keyof typeof UPLOAD_INTENT_STATUS];

export const UPLOAD_INTENT_STATUSES = Object.values(
  UPLOAD_INTENT_STATUS,
) as readonly UploadIntentStatus[];

/**
 * The states from which nothing further happens.
 *
 * An attempt to finalize one of these is answered from the stored state without
 * touching the provider: replaying a finalized upload returns the same object,
 * and replaying a rejected one keeps saying no.
 */
export const TERMINAL_UPLOAD_INTENT_STATUSES = [
  UPLOAD_INTENT_STATUS.FINALIZED,
  UPLOAD_INTENT_STATUS.QUARANTINED,
  UPLOAD_INTENT_STATUS.REJECTED,
  UPLOAD_INTENT_STATUS.EXPIRED,
] as const satisfies readonly UploadIntentStatus[];

export function isTerminalUploadIntentStatus(
  status: UploadIntentStatus,
): boolean {
  return (TERMINAL_UPLOAD_INTENT_STATUSES as readonly string[]).includes(
    status,
  );
}

export const STORAGE_INSPECTION_RESULT = {
  /** No inspector was supplied. The file was never looked at. */
  NOT_CONFIGURED: "not-configured",
  CLEAN: "clean",
  QUARANTINED: "quarantined",
} as const;

export type StorageInspectionResult =
  (typeof STORAGE_INSPECTION_RESULT)[keyof typeof STORAGE_INSPECTION_RESULT];

export const STORAGE_INSPECTION_RESULTS = Object.values(
  STORAGE_INSPECTION_RESULT,
) as readonly StorageInspectionResult[];

/**
 * Why an upload did not become a usable object.
 *
 * A closed set of stable codes. A caller may show one, log one, or branch on
 * one; none of them carries a provider message, a key, a size, or a checksum,
 * so none of them can turn into a way of probing what was uploaded.
 */
export const STORAGE_FAILURE_REASON = {
  MISSING_UPLOAD: "missing-upload",
  SIZE_MISMATCH: "size-mismatch",
  CHECKSUM_MISMATCH: "checksum-mismatch",
  CONTENT_TYPE_MISMATCH: "content-type-mismatch",
  INSPECTION_UNAVAILABLE: "inspection-unavailable",
  QUARANTINED: "quarantined",
  EXPIRED: "expired",
  ABANDONED: "abandoned",
} as const;

export type StorageFailureReason =
  (typeof STORAGE_FAILURE_REASON)[keyof typeof STORAGE_FAILURE_REASON];

export const STORAGE_FAILURE_REASONS = Object.values(
  STORAGE_FAILURE_REASON,
) as readonly StorageFailureReason[];

/**
 * Everything the platform knows about an object that is ready to be used.
 *
 * Deliberately not "the row". The key is missing, and so are the staging key,
 * the bucket, the endpoint, the entity tag, the provider version marker, the
 * finalize token hash, and the lease. A calling module holds `id` and asks for a
 * download URL when it needs one; it never learns where the bytes are, which is
 * what lets the key layout and the provider change without touching it.
 *
 * `sizeBytes` is a `number` rather than the `BigInt` the column holds. The
 * deployment ceiling is validated well below `Number.MAX_SAFE_INTEGER`, so the
 * conversion is exact — and a `BigInt` in a DTO is a value that throws the first
 * time anything calls `JSON.stringify` on it.
 */
export type StorageObjectMetadata = Readonly<{
  id: string;
  status: typeof STORAGE_OBJECT_STATUS.READY;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  readyAt: string;
  inspection: StorageInspectionResult;
}>;

/** The object row, as the platform's own use cases see it. */
export type StoredStorageObject = Readonly<{
  id: string;
  status: StorageObjectStatus;
  objectKey: string;
  contentType: string | null;
  sizeBytes: bigint | null;
  checksumSha256: string | null;
  etag: string | null;
  inspectionResult: StorageInspectionResult | null;
  inspectionReason: string | null;
  readyAt: Date | null;
  quarantinedAt: Date | null;
  createdAt: Date;
}>;

/** The intent row, as the platform's own use cases see it. */
export type StoredUploadIntent = Readonly<{
  id: string;
  objectId: string;
  status: UploadIntentStatus;
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

/**
 * The safe view of a ready object, or `null`.
 *
 * `null` for anything that is not ready — pending, quarantined, rejected,
 * expired — rather than a DTO with a different status. A caller that receives a
 * value can use it; there is no state in which it has to remember to check one
 * more field before serving a file.
 */
export function toStorageObjectMetadata(
  object: StoredStorageObject,
): StorageObjectMetadata | null {
  if (
    object.status !== STORAGE_OBJECT_STATUS.READY ||
    object.contentType === null ||
    object.sizeBytes === null ||
    object.checksumSha256 === null ||
    object.readyAt === null ||
    object.inspectionResult === null
  ) {
    return null;
  }

  return {
    id: object.id,
    status: STORAGE_OBJECT_STATUS.READY,
    contentType: object.contentType,
    sizeBytes: Number(object.sizeBytes),
    checksumSha256: object.checksumSha256,
    readyAt: object.readyAt.toISOString(),
    inspection: object.inspectionResult,
  };
}
