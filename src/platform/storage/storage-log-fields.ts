/**
 * The complete allowlist of fields a storage log line may carry.
 *
 * Storage is the area of this application with the largest supply of things
 * that must not be logged, and the line most likely to want them is the one
 * reporting a failure. A presigned URL is a bearer credential for the duration
 * of its signature; a finalize token authorizes a completion; an endpoint and a
 * bucket name are the two halves of "where is this data"; a storage key is the
 * address of one object; a checksum and a size fingerprint a file well enough to
 * confirm a guess about which one it is. None of them appear here, so no call
 * site can decide otherwise in the moment.
 *
 * What is left is what an operator actually needs: which intent, which object,
 * which policy, how it ended, why in stable terms, and how long it took.
 */
export type StorageLogFields = Readonly<{
  intentId?: string;
  objectId?: string;
  policyName?: string;
  outcome?: string;
  reasonCode?: string;
  requestId?: string;
  errorCode?: string;
  durationMs?: number;
  deleted?: number;
  examined?: number;
}>;

export type StorageLogInput = Readonly<{
  intentId?: string | undefined;
  objectId?: string | undefined;
  policyName?: string | undefined;
  outcome?: string | undefined;
  reasonCode?: string | undefined;
  requestId?: string | null | undefined;
  errorCode?: string | undefined;
  durationMs?: number | undefined;
  deleted?: number | undefined;
  examined?: number | undefined;
}>;

/**
 * The field names a line may carry, in one list.
 *
 * Exported so a contract test can assert that the allowlist and the documented
 * set are the same list rather than two lists that agree today.
 */
export const STORAGE_LOG_FIELD_NAMES = [
  "intentId",
  "objectId",
  "policyName",
  "outcome",
  "reasonCode",
  "requestId",
  "errorCode",
  "durationMs",
  "deleted",
  "examined",
] as const;

/**
 * Builds the payload for a storage event.
 *
 * Absent values are omitted rather than serialized as `null`, so a line never
 * claims to know something it does not, and anything the input carries beyond
 * the allowlist is dropped here rather than at each call site.
 */
export function toStorageLogFields(input: StorageLogInput): StorageLogFields {
  const source = input as Record<string, unknown>;
  const fields: Record<string, unknown> = {};

  for (const name of STORAGE_LOG_FIELD_NAMES) {
    const value = source[name];

    if (value !== undefined && value !== null) {
      fields[name] = value;
    }
  }

  return fields as StorageLogFields;
}
