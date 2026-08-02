/**
 * The provider port.
 *
 * Everything above this file is written against these types and never against
 * the AWS SDK. That is what keeps `@aws-sdk/*` inside `provider/`, and it is
 * enforced by an ESLint boundary, a dependency-cruiser rule, and a contract
 * test rather than by discipline.
 *
 * The port is deliberately small and deliberately not a general S3 client. It
 * exposes the eight operations the upload lifecycle needs and nothing else — no
 * bucket creation, no listing, no ACL, no policy, no tagging, no versioning.
 * An operation that does not exist here cannot be reached from a use case, so
 * "the application never makes a bucket public" is a property of this interface
 * rather than a rule somebody has to review for.
 *
 * No type here mentions a bucket. The bucket is configuration; a use case that
 * could name one could name a different one.
 */

/** Why a provider call failed, in terms the platform can act on. */
export const STORAGE_PROVIDER_FAILURE = {
  /** The object is not there. Distinct from every other failure. */
  NOT_FOUND: "not-found",
  /** The precondition on a conditional copy did not hold. */
  PRECONDITION_FAILED: "precondition-failed",
  /** Refused: wrong credentials, or a policy that forbids the call. */
  ACCESS_DENIED: "access-denied",
  /** The bucket named in the configuration does not exist. */
  BUCKET_NOT_FOUND: "bucket-not-found",
  /** Unreachable, timed out, or answered with a server error. */
  UNAVAILABLE: "unavailable",
} as const;

export type StorageProviderFailureCode =
  (typeof STORAGE_PROVIDER_FAILURE)[keyof typeof STORAGE_PROVIDER_FAILURE];

/**
 * The only error shape that leaves the adapter.
 *
 * It carries a code from the closed set above and nothing else. No provider
 * message, no request identifier, no bucket, no key, no endpoint, no HTTP body:
 * a provider error is one of the richest sources of infrastructure detail in a
 * system, and this class is where that detail stops.
 */
export class StorageProviderError extends Error {
  readonly failure: StorageProviderFailureCode;

  constructor(failure: StorageProviderFailureCode) {
    super(`The storage provider call failed: ${failure}.`);
    this.name = "StorageProviderError";
    this.failure = failure;
    Object.setPrototypeOf(this, StorageProviderError.prototype);
  }
}

export function isStorageProviderError(
  error: unknown,
): error is StorageProviderError {
  return error instanceof StorageProviderError;
}

/** A presigned form the browser posts the bytes to. The bytes never come here. */
export type PresignedUpload = Readonly<{
  method: "POST";
  url: string;
  fields: Readonly<Record<string, string>>;
}>;

export type PresignedUploadRequest = Readonly<{
  key: string;
  contentType: string;
  /** Enforced by the provider as an exact `content-length-range`. */
  sizeBytes: number;
  checksumSha256: string;
  expiresInSeconds: number;
}>;

export type StorageObjectHead = Readonly<{
  sizeBytes: number;
  contentType: string | null;
  etag: string | null;
  /**
   * The provider's own SHA-256, in canonical hex, when it returned one it
   * computed. `null` means "not offered", never "did not match" — an absent
   * checksum makes the platform read the object and compute its own.
   */
  checksumSha256: string | null;
}>;

export type PresignedDownloadRequest = Readonly<{
  key: string;
  expiresInSeconds: number;
  contentType?: string;
  contentDisposition?: string;
}>;

export type ConditionalCopyRequest = Readonly<{
  sourceKey: string;
  destinationKey: string;
  contentType: string;
  /**
   * The copy proceeds only if the source still has this entity tag. It is what
   * closes the window between verifying the staged bytes and promoting them: a
   * client that re-uploaded in between changes the tag, and the copy fails
   * rather than promoting bytes nobody checked.
   */
  sourceEtag: string;
}>;

export type ReadObjectRequest = Readonly<{
  key: string;
  /** The read aborts past this, so a lying `Content-Length` cannot exhaust memory. */
  maxBytes: number;
}>;

export type StorageProvider = Readonly<{
  createPresignedUpload: (
    request: PresignedUploadRequest,
  ) => Promise<PresignedUpload>;
  headObject: (key: string) => Promise<StorageObjectHead>;
  /** Streams the object and returns the SHA-256 of what it actually read. */
  computeObjectChecksum: (request: ReadObjectRequest) => Promise<string>;
  copyObjectConditionally: (request: ConditionalCopyRequest) => Promise<string>;
  deleteObject: (key: string) => Promise<void>;
  createPresignedDownload: (
    request: PresignedDownloadRequest,
  ) => Promise<string>;
  checkBucket: () => Promise<void>;
  destroy: () => void;
}>;
