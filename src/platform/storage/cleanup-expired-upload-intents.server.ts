import "server-only";

import { logger } from "@/platform/observability/logger.server";
import { startOperationTimer } from "@/platform/observability/operation-timer.server";
import {
  DependencyUnavailableError,
  ValidationError,
} from "@/shared/errors/application-error";

import { getStorageConfiguration } from "./config";
import { STORAGE_LOG_EVENT } from "./log-event";
import { getStorageProvider } from "./provider/storage-client.server";
import type { StorageProvider } from "./provider/storage-provider";
import {
  claimCleanupCandidate,
  expireStorageObject,
  findCleanupCandidates,
} from "./storage-repository.server";
import { toStorageLogFields } from "./storage-log-fields";
import { STORAGE_OBJECT_STATUS, UPLOAD_INTENT_STATUS } from "./storage-object";

/**
 * Removing what an unfinished upload left behind.
 *
 * This is a contract, not a background job. Nothing schedules it: there is no
 * cron, no queue, no worker, and no timer anywhere in this platform. A
 * deployment that wants it run wires it to whatever scheduler it already has,
 * which is a decision about operations rather than about storage.
 *
 * What it collects is narrow on purpose:
 *
 * - `pending` intents whose lifetime ran out, and the staged bytes under them.
 * - `finalizing` intents whose lease lapsed *and* whose lifetime ran out — the
 *   second condition is what preserves the retry window, so a finalization that
 *   is merely slow is never mistaken for one that died.
 * - The final object an attempt may have written just before failing to commit.
 *   That is the orphan §18 describes, and this is what collects it.
 *
 * What it never touches is equally deliberate. It deletes only keys that a row
 * in PostgreSQL names — never by listing the bucket, never by prefix, never a
 * key it computed. It cannot reach a `ready` object, because a ready object's
 * intent is `finalized` and neither candidate condition admits that status. And
 * it never deletes a quarantined object: an inspector withheld those on purpose,
 * and the bytes are the evidence.
 */
export const DEFAULT_CLEANUP_LIMIT = 25;
export const MAX_CLEANUP_LIMIT = 200;

export type CleanupUploadIntentsInput = Readonly<{
  /** Bounded and mandatory in effect: omitted means the small default. */
  limit?: number;
  now?: Date;
}>;

export type CleanupUploadIntentsResult = Readonly<{
  examined: number;
  expiredIntents: number;
  deletedObjects: number;
  failedDeletes: number;
}>;

async function deleteIfPresent(
  provider: StorageProvider,
  key: string,
  fields: { intentId: string; objectId: string },
): Promise<boolean> {
  try {
    await provider.deleteObject(key);

    return true;
  } catch {
    // One failed delete does not stop the pass. The intent is already expired
    // in PostgreSQL, so the key stays reachable through the row and a later pass
    // finds it again — whereas aborting here would leave the rest of the batch
    // untouched because of one unlucky object.
    logger.warn(
      toStorageLogFields(fields),
      STORAGE_LOG_EVENT.CLEANUP_OBJECT_DELETE_FAILED,
    );

    return false;
  }
}

export async function cleanupExpiredUploadIntents(
  input: CleanupUploadIntentsInput = {},
): Promise<CleanupUploadIntentsResult> {
  const configuration = getStorageConfiguration();

  if (!configuration.enabled) {
    throw new DependencyUnavailableError("Object storage is not enabled.");
  }

  const limit = input.limit ?? DEFAULT_CLEANUP_LIMIT;

  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_CLEANUP_LIMIT) {
    throw new ValidationError(
      `A cleanup batch must be between 1 and ${MAX_CLEANUP_LIMIT}.`,
    );
  }

  const provider = getStorageProvider();

  if (provider === null) {
    throw new DependencyUnavailableError("Object storage is not enabled.");
  }

  const now = input.now ?? new Date();
  const timer = startOperationTimer();
  const candidates = await findCleanupCandidates({ now, limit });

  let expiredIntents = 0;
  let deletedObjects = 0;
  let failedDeletes = 0;

  for (const candidate of candidates) {
    const { intent, object } = candidate;

    // Claiming first means the row is already expired before any key is
    // deleted. If the process dies mid-pass, the worst outcome is a key that
    // outlives its row for one more cycle — never a live intent whose staged
    // bytes were removed underneath it.
    const claimed = await claimCleanupCandidate({
      intentId: intent.id,
      expectedVersion: intent.version,
      expectedStatus: intent.status,
      now,
    });

    if (!claimed) {
      continue;
    }

    expiredIntents += 1;

    const fields = { intentId: intent.id, objectId: object.id };

    if (await deleteIfPresent(provider, intent.stagingKey, fields)) {
      deletedObjects += 1;
    } else {
      failedDeletes += 1;
    }

    // The final key is only worth visiting for an attempt that got as far as
    // `finalizing`: a `pending` intent never reached the copy, so there is
    // nothing there and the call would be a wasted round trip. A quarantined
    // object is unreachable here — its intent is terminal — so this can never
    // delete withheld evidence.
    if (
      intent.status === UPLOAD_INTENT_STATUS.FINALIZING &&
      object.status === STORAGE_OBJECT_STATUS.PENDING
    ) {
      if (await deleteIfPresent(provider, object.objectKey, fields)) {
        deletedObjects += 1;
      } else {
        failedDeletes += 1;
      }
    }

    await expireStorageObject(object.id);
  }

  logger.info(
    toStorageLogFields({
      examined: candidates.length,
      deleted: deletedObjects,
      durationMs: timer.elapsedMs(),
    }),
    STORAGE_LOG_EVENT.CLEANUP_COMPLETED,
  );

  return {
    examined: candidates.length,
    expiredIntents,
    deletedObjects,
    failedDeletes,
  };
}
