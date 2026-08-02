import "server-only";

/**
 * The controlled server-only entry point for object storage.
 *
 * Application code imports storage from here and never from a file inside the
 * directory: an ESLint boundary, a dependency-cruiser rule, and a contract test
 * keep it that way, so removing storage from a generated project is a matter of
 * deleting this directory rather than hunting for imports.
 *
 * Importing this module builds no client, reads no credential, and opens no
 * socket.
 *
 * What is deliberately absent is as much of the contract as what is present:
 *
 * - The S3 client, and every AWS SDK type. They stay in `provider/`.
 * - The repository. A caller that could write a row could move an object to
 *   `ready` without the verification that is supposed to precede it.
 * - The bucket, the endpoint, the credentials, and their types.
 * - Storage keys, in any form, and the functions that build them.
 * - The finalize token's hash and the lease token.
 * - Raw provider errors.
 *
 * There is no `index.client.ts`. Nothing in this platform is safe in a browser
 * bundle, and the upload the browser performs is a plain form POST to a URL the
 * server signed — it needs no client library at all.
 */
export {
  cleanupExpiredUploadIntents,
  DEFAULT_CLEANUP_LIMIT,
  MAX_CLEANUP_LIMIT,
  type CleanupUploadIntentsInput,
  type CleanupUploadIntentsResult,
} from "./cleanup-expired-upload-intents.server";

export {
  getStorageConfiguration,
  isStorageEnabled,
  resetStorageConfiguration,
  type StorageConfiguration,
} from "./config";

export {
  INSPECTION_OUTCOME,
  isValidInspectionReason,
  MAX_INSPECTION_REASON_LENGTH,
  UNSPECIFIED_INSPECTION_REASON,
  type InspectionOutcome,
  type StorageContentInspector,
  type StorageInspectionRequest,
  type StorageInspectionVerdict,
} from "./content-inspector";

export {
  createStorageDownloadUrl,
  type CreateStorageDownloadUrlInput,
  type StorageDownload,
} from "./create-storage-download-url.server";

export {
  createUploadIntent,
  type CreatedUploadIntent,
  type CreateUploadIntentInput,
} from "./create-upload-intent.server";

export {
  type UploadFileDeclaration,
  type ValidatedUploadFileDeclaration,
} from "./file-declaration";

export {
  finalizeUploadIntent,
  type FinalizedUpload,
  type FinalizeUploadIntentInput,
} from "./finalize-upload-intent.server";

export { getStorageObjectMetadata } from "./get-storage-object-metadata.server";

export {
  checkStorageHealth,
  STORAGE_HEALTH_STATUS,
  type StorageHealth,
  type StorageHealthStatus,
} from "./health.server";

export { STORAGE_LOG_EVENT, type StorageLogEvent } from "./log-event";

export { closeStorageClient } from "./provider/storage-client.server";

export type { PresignedUpload } from "./provider/storage-provider";

export {
  MAX_DOWNLOAD_FILENAME_BYTES,
  isSafeDownloadFilename,
} from "./safe-filename";

export {
  STORAGE_LOG_FIELD_NAMES,
  type StorageLogFields,
} from "./storage-log-fields";

export {
  STORAGE_FAILURE_REASON,
  STORAGE_FAILURE_REASONS,
  STORAGE_INSPECTION_RESULT,
  STORAGE_INSPECTION_RESULTS,
  STORAGE_OBJECT_STATUS,
  STORAGE_OBJECT_STATUSES,
  UPLOAD_INTENT_STATUS,
  UPLOAD_INTENT_STATUSES,
  type StorageFailureReason,
  type StorageInspectionResult,
  type StorageObjectMetadata,
  type StorageObjectStatus,
  type UploadIntentStatus,
} from "./storage-object";

export {
  defineUploadPolicy,
  isValidUploadContentType,
  isValidUploadExtension,
  isValidUploadPolicyName,
  MAX_CONTENT_TYPE_LENGTH,
  MAX_POLICY_NAME_LENGTH,
  UPLOAD_INSPECTION,
  type AllowedUploadFile,
  type UploadInspection,
  type UploadPolicy,
  type UploadPolicyDefinition,
} from "./upload-policy";
