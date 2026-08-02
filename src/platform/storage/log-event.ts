/**
 * The stable log events of the storage platform.
 *
 * Names are part of the operational contract: an alert or a dashboard is built
 * on them, so they change like an API changes rather than like a message does.
 */
export const STORAGE_LOG_EVENT = {
  UPLOAD_INTENT_CREATED: "storage.upload_intent.created",
  UPLOAD_FINALIZED: "storage.upload.finalized",
  UPLOAD_REJECTED: "storage.upload.rejected",
  UPLOAD_QUARANTINED: "storage.upload.quarantined",
  PROVIDER_UNAVAILABLE: "storage.provider.unavailable",
  STAGING_DELETE_FAILED: "storage.staging_delete_failed",
  CLEANUP_OBJECT_DELETE_FAILED: "storage.cleanup.object_delete_failed",
  CLEANUP_COMPLETED: "storage.cleanup.completed",
} as const;

export type StorageLogEvent =
  (typeof STORAGE_LOG_EVENT)[keyof typeof STORAGE_LOG_EVENT];
