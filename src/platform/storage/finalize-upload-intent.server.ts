import "server-only";

import { logger } from "@/platform/observability/logger.server";
import {
  ConflictError,
  DependencyUnavailableError,
  NotFoundError,
} from "@/shared/errors/application-error";

import { sha256HexEquals } from "./checksum";
import { getStorageConfiguration, getStorageKeyScope } from "./config";
import {
  INSPECTION_OUTCOME,
  toStoredInspectionReason,
  type StorageContentInspector,
} from "./content-inspector";
import {
  createLeaseToken,
  finalizeTokenMatches,
  hashLeaseToken,
} from "./finalize-token";
import { STORAGE_LOG_EVENT } from "./log-event";
import { requireStorageProvider } from "./provider/storage-client.server";
import {
  isStorageProviderError,
  STORAGE_PROVIDER_FAILURE,
  type StorageObjectHead,
  type StorageProvider,
} from "./provider/storage-provider";
import {
  claimUploadIntent,
  completeUploadIntent,
  failUploadIntent,
  findStorageObjectById,
  findUploadIntentById,
  reclaimUploadIntent,
  releaseUploadIntent,
} from "./storage-repository.server";
import { STORAGE_NAMESPACE, buildStorageKey } from "./storage-key";
import { toStorageLogFields } from "./storage-log-fields";
import {
  STORAGE_FAILURE_REASON,
  STORAGE_INSPECTION_RESULT,
  STORAGE_OBJECT_STATUS,
  UPLOAD_INTENT_STATUS,
  toStorageObjectMetadata,
  type StorageFailureReason,
  type StorageInspectionResult,
  type StorageObjectMetadata,
  type StoredUploadIntent,
} from "./storage-object";
import { UPLOAD_INSPECTION, type UploadPolicy } from "./upload-policy";

/**
 * Turning a staged upload into a usable object.
 *
 * This is the longest path in the platform and the one worth reading in full,
 * because everything the area promises is decided here.
 *
 * The shape is: claim the intent atomically, then do all the slow work with no
 * database transaction open, then commit the result in a short one. That order
 * is not a performance preference. A transaction held across a provider call
 * would hold row locks for the length of an HTTP round trip and, when the
 * provider hangs, for the length of a timeout — and the finalization of one
 * upload would be able to stall unrelated writes.
 *
 * The three failure windows are handled differently on purpose, and §18 of the
 * design says why:
 *
 * - Before the copy, a provider failure is recoverable. The lease is released,
 *   the intent goes back to `pending`, and the client may retry within the
 *   intent's original lifetime. Nothing was written to the bucket.
 * - After the copy but before the commit, a final object may exist that no row
 *   points at. The platform does not claim success, issues no download, and
 *   leaves the intent in a state cleanup recognizes. There is no exactly-once
 *   transaction between PostgreSQL and S3, and pretending otherwise would be the
 *   real defect.
 * - After a successful commit, deleting the staged copy is best effort. A
 *   completed upload is never turned back into a retryable failure because a
 *   `DeleteObject` failed; cleanup removes the leftover later.
 */
export type FinalizeUploadIntentInput = Readonly<{
  intentId: string;
  finalizeToken: string;
  /**
   * The same policy the intent was created under. Passed rather than looked up:
   * a name resolved through a table is a name a request could eventually
   * supply, and the policy decides whether inspection is mandatory.
   */
  policy: UploadPolicy;
  inspector?: StorageContentInspector;
  requestId?: string;
  now?: Date;
}>;

export type FinalizedUpload = Readonly<{
  object: StorageObjectMetadata;
}>;

/**
 * An unknown intent and a wrong token are answered identically.
 *
 * Both produce this error, with the same message, on the same code path. If
 * they differed — a 404 for one and a 403 for the other — a caller holding a
 * list of identifiers could learn which of them are real intents, and an
 * attacker with a valid identifier could learn that its token guess was the only
 * thing wrong.
 */
function unknownIntent(): never {
  throw new NotFoundError("The upload intent could not be finalized.");
}

function toProviderError(error: unknown): never {
  if (isStorageProviderError(error)) {
    throw new DependencyUnavailableError(
      "The storage provider is unavailable.",
    );
  }

  throw error;
}

/**
 * Reads the intent and refuses anything that is not finalizable.
 *
 * A finalized intent is *not* refused: replaying a finalization with the right
 * token returns the same object rather than an error, because a client that
 * never saw the first response has to be able to ask again.
 */
async function loadFinalizableIntent(
  intentId: string,
  finalizeToken: string,
): Promise<StoredUploadIntent> {
  const intent = await findUploadIntentById(intentId);

  if (intent === null) {
    unknownIntent();
  }

  if (!finalizeTokenMatches(finalizeToken, intent.finalizeTokenHash)) {
    unknownIntent();
  }

  return intent;
}

async function replayFinalized(
  intent: StoredUploadIntent,
): Promise<FinalizedUpload> {
  const object = await findStorageObjectById(intent.objectId);
  const metadata = object === null ? null : toStorageObjectMetadata(object);

  if (metadata === null) {
    // The intent says finalized and the object is not ready. A database
    // constraint makes that unreachable through the application, so reaching it
    // means the row was changed by hand; refusing is the only honest answer.
    throw new ConflictError("The finalized object is not readable.");
  }

  return { object: metadata };
}

type Claim = Readonly<{
  intent: StoredUploadIntent;
  leaseToken: string;
  leaseTokenHash: string;
}>;

/**
 * Takes the lease, or explains why it could not.
 *
 * A `pending` intent is claimed. A `finalizing` intent whose lease has lapsed is
 * reclaimed — and the version increments, which is what makes the previous
 * holder's later commit a no-op rather than a second promotion. A `finalizing`
 * intent with a live lease is a conflict: something else is working on it right
 * now, and the honest answer is to say so rather than to race it.
 */
async function claim(
  intent: StoredUploadIntent,
  leaseMs: number,
  now: Date,
): Promise<Claim> {
  const leaseToken = createLeaseToken();
  const leaseTokenHash = hashLeaseToken(leaseToken);
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  if (intent.status === UPLOAD_INTENT_STATUS.PENDING) {
    if (intent.expiresAt.getTime() <= now.getTime()) {
      throw new ConflictError("The upload intent has expired.");
    }

    const claimed = await claimUploadIntent({
      intentId: intent.id,
      expectedVersion: intent.version,
      leaseTokenHash,
      leaseExpiresAt,
      now,
    });

    if (claimed === null) {
      throw new ConflictError("The upload intent is already being finalized.");
    }

    return { intent: claimed, leaseToken, leaseTokenHash };
  }

  const leaseExpired =
    intent.finalizeLeaseExpiresAt !== null &&
    intent.finalizeLeaseExpiresAt.getTime() <= now.getTime();

  if (!leaseExpired) {
    throw new ConflictError("The upload intent is already being finalized.");
  }

  const reclaimed = await reclaimUploadIntent({
    intentId: intent.id,
    expectedVersion: intent.version,
    leaseTokenHash,
    leaseExpiresAt,
    now,
  });

  if (reclaimed === null) {
    throw new ConflictError("The upload intent is already being finalized.");
  }

  return { intent: reclaimed, leaseToken, leaseTokenHash };
}

/**
 * Compares what the provider actually holds against what the client declared.
 *
 * The checksum is the load-bearing check and the other two are cheap
 * corroboration. Size and content type come from provider metadata, which is
 * derived from what the client sent; the SHA-256 is either computed by the
 * provider or computed here by reading the object, and it is the only one of the
 * three that the client cannot simply assert.
 *
 * The ETag is deliberately not used as a checksum. For a multipart or
 * server-side-encrypted object it is not an MD5 of the content, and it is never
 * a SHA-256 under any circumstances, so treating it as one would be a check that
 * silently means nothing on exactly the objects that are hardest to reason
 * about.
 */
async function verifyStagedObject(
  provider: StorageProvider,
  intent: StoredUploadIntent,
  head: StorageObjectHead,
): Promise<StorageFailureReason | null> {
  const expectedSize = Number(intent.expectedSizeBytes);

  if (head.sizeBytes !== expectedSize) {
    return STORAGE_FAILURE_REASON.SIZE_MISMATCH;
  }

  if (
    head.contentType !== null &&
    head.contentType !== intent.expectedContentType
  ) {
    return STORAGE_FAILURE_REASON.CONTENT_TYPE_MISMATCH;
  }

  // When the provider computed and stored a SHA-256, that is authoritative and
  // costs one metadata read. When it did not — and several S3-compatible
  // providers do not — the object is streamed and hashed here, bounded by the
  // size the client declared so a lying `Content-Length` cannot be turned into
  // unbounded work.
  const actualChecksum =
    head.checksumSha256 ??
    (await provider.computeObjectChecksum({
      key: intent.stagingKey,
      maxBytes: expectedSize,
    }));

  if (!sha256HexEquals(actualChecksum, intent.expectedChecksumSha256)) {
    return STORAGE_FAILURE_REASON.CHECKSUM_MISMATCH;
  }

  return null;
}

async function deleteQuietly(
  provider: StorageProvider,
  key: string,
  fields: { intentId: string; objectId: string },
): Promise<void> {
  try {
    await provider.deleteObject(key);
  } catch {
    // A leftover staged object is a cost, not a correctness problem: nothing
    // points at it, no download can be issued for it, and the cleanup contract
    // removes it. Turning a completed finalization into a retryable failure
    // over it would be strictly worse.
    logger.warn(
      toStorageLogFields(fields),
      STORAGE_LOG_EVENT.STAGING_DELETE_FAILED,
    );
  }
}

export async function finalizeUploadIntent(
  input: FinalizeUploadIntentInput,
): Promise<FinalizedUpload> {
  const configuration = getStorageConfiguration();

  if (!configuration.enabled) {
    throw new DependencyUnavailableError("Object storage is not enabled.");
  }

  const now = input.now ?? new Date();
  const loaded = await loadFinalizableIntent(
    input.intentId,
    input.finalizeToken,
  );

  if (loaded.status === UPLOAD_INTENT_STATUS.FINALIZED) {
    return replayFinalized(loaded);
  }

  if (
    loaded.status === UPLOAD_INTENT_STATUS.REJECTED ||
    loaded.status === UPLOAD_INTENT_STATUS.QUARANTINED ||
    loaded.status === UPLOAD_INTENT_STATUS.EXPIRED
  ) {
    throw new ConflictError("The upload intent can no longer be finalized.");
  }

  // The policy that finalizes must be the policy that authorized. Otherwise a
  // caller holding a token could finalize an upload created under a strict
  // policy by presenting a lax one, and `inspection: required` would be
  // optional in practice.
  if (loaded.policyName !== input.policy.name) {
    throw new ConflictError(
      "The upload intent belongs to a different upload policy.",
    );
  }

  const inspectionRequired =
    input.policy.inspection === UPLOAD_INSPECTION.REQUIRED;

  // Checked before the lease is taken. Failing closed is the point of
  // `required`, and doing it here means a deployment with no inspector does not
  // repeatedly claim, fail, and release every intent under such a policy.
  if (inspectionRequired && input.inspector === undefined) {
    throw new DependencyUnavailableError(
      "This upload policy requires content inspection, and no inspector is configured.",
    );
  }

  const provider = requireStorageProvider();
  const claimed = await claim(loaded, configuration.finalizeLeaseMs, now);
  const intent = claimed.intent;

  const logFields = { intentId: intent.id, objectId: intent.objectId };

  /** Ends the attempt without a promotion, and says why in stable terms. */
  const reject = async (reason: StorageFailureReason): Promise<never> => {
    await failUploadIntent({
      intentId: intent.id,
      objectId: intent.objectId,
      expectedVersion: intent.version,
      leaseTokenHash: claimed.leaseTokenHash,
      intentStatus: UPLOAD_INTENT_STATUS.REJECTED,
      objectStatus: STORAGE_OBJECT_STATUS.REJECTED,
      reason,
      inspection: null,
      now,
    });

    await deleteQuietly(provider, intent.stagingKey, logFields);

    logger.warn(
      toStorageLogFields({
        ...logFields,
        policyName: intent.policyName,
        reasonCode: reason,
        requestId: input.requestId,
      }),
      STORAGE_LOG_EVENT.UPLOAD_REJECTED,
    );

    throw new ConflictError(
      "The uploaded object did not match its declaration.",
    );
  };

  /** Releases the claim so the client can retry inside the intent's lifetime. */
  const releaseAndFail = async (error: unknown): Promise<never> => {
    await releaseUploadIntent({
      intentId: intent.id,
      expectedVersion: intent.version,
      leaseTokenHash: claimed.leaseTokenHash,
    });

    logger.error(
      toStorageLogFields({ ...logFields, requestId: input.requestId }),
      STORAGE_LOG_EVENT.PROVIDER_UNAVAILABLE,
    );

    return toProviderError(error);
  };

  let head: StorageObjectHead;

  try {
    head = await provider.headObject(intent.stagingKey);
  } catch (error) {
    if (
      isStorageProviderError(error) &&
      error.failure === STORAGE_PROVIDER_FAILURE.NOT_FOUND
    ) {
      // Nothing was ever uploaded. That is the client's failure, not the
      // provider's, so it is terminal rather than retryable: the presigned form
      // has a lifetime, and re-running finalization would not make bytes appear.
      return reject(STORAGE_FAILURE_REASON.MISSING_UPLOAD);
    }

    return releaseAndFail(error);
  }

  let mismatch: StorageFailureReason | null;

  try {
    mismatch = await verifyStagedObject(provider, intent, head);
  } catch (error) {
    if (
      isStorageProviderError(error) &&
      error.failure === STORAGE_PROVIDER_FAILURE.PRECONDITION_FAILED
    ) {
      // The streamed read hit the byte ceiling: the object is larger than the
      // declaration said, whatever its `Content-Length` claimed.
      return reject(STORAGE_FAILURE_REASON.SIZE_MISMATCH);
    }

    return releaseAndFail(error);
  }

  if (mismatch !== null) {
    return reject(mismatch);
  }

  if (head.etag === null) {
    // Without an entity tag there is no way to make the promotion conditional,
    // and an unconditional copy would be a window in which a client could swap
    // the staged bytes between verification and promotion. Refusing is the only
    // answer that does not quietly weaken the guarantee.
    return releaseAndFail(
      new DependencyUnavailableError(
        "The storage provider did not return an entity tag for the staged object.",
      ),
    );
  }

  let inspection: StorageInspectionResult =
    STORAGE_INSPECTION_RESULT.NOT_CONFIGURED;

  if (input.inspector !== undefined) {
    let verdict;

    try {
      verdict = await input.inspector.inspect({
        objectId: intent.objectId,
        key: intent.stagingKey,
        sizeBytes: head.sizeBytes,
        declaredContentType: intent.expectedContentType,
      });
    } catch {
      // An inspector that threw did not reach a verdict, so the file is
      // unexamined. Under a `required` policy that must fail closed; under an
      // optional one it would be dishonest to record `clean`, so the attempt is
      // released and can be retried. The thrown value is deliberately not read:
      // a scanner error message is exactly the kind of third-party string that
      // must not reach a log or a caller.
      return releaseAndFail(
        new DependencyUnavailableError("Content inspection failed."),
      );
    }

    if (verdict.outcome === INSPECTION_OUTCOME.QUARANTINE) {
      const reason = toStoredInspectionReason(verdict.reasonCode);
      const quarantineKey = buildStorageKey(
        getStorageKeyScope(),
        STORAGE_NAMESPACE.QUARANTINE,
      );

      // The bytes are kept, out of the way, under a key nothing will ever sign a
      // download for. Deleting them would be tidier and would also destroy the
      // only evidence of what was uploaded.
      try {
        await provider.copyObjectConditionally({
          sourceKey: intent.stagingKey,
          destinationKey: quarantineKey,
          contentType: intent.expectedContentType,
          sourceEtag: head.etag,
        });
      } catch (error) {
        return releaseAndFail(error);
      }

      await failUploadIntent({
        intentId: intent.id,
        objectId: intent.objectId,
        expectedVersion: intent.version,
        leaseTokenHash: claimed.leaseTokenHash,
        intentStatus: UPLOAD_INTENT_STATUS.QUARANTINED,
        objectStatus: STORAGE_OBJECT_STATUS.QUARANTINED,
        reason,
        inspection: STORAGE_INSPECTION_RESULT.QUARANTINED,
        quarantineKey,
        now,
      });

      await deleteQuietly(provider, intent.stagingKey, logFields);

      logger.warn(
        toStorageLogFields({
          ...logFields,
          policyName: intent.policyName,
          reasonCode: reason,
          requestId: input.requestId,
        }),
        STORAGE_LOG_EVENT.UPLOAD_QUARANTINED,
      );

      throw new ConflictError("The uploaded object was withheld.");
    }

    inspection = STORAGE_INSPECTION_RESULT.CLEAN;
  }

  const object = await findStorageObjectById(intent.objectId);

  if (object === null) {
    return releaseAndFail(
      new DependencyUnavailableError("The storage object row is missing."),
    );
  }

  let finalEtag: string;

  try {
    // The promotion, and the single most important call in the platform. It is
    // conditional on the source entity tag, so a client that re-uploaded into
    // staging between the verification above and this line breaks the condition
    // and the copy fails — the final object is never written from bytes nobody
    // checked.
    //
    // Everything after this point may leave an orphan at `object.objectKey` if
    // the process dies, and the cleanup contract is what collects it.
    finalEtag = await provider.copyObjectConditionally({
      sourceKey: intent.stagingKey,
      destinationKey: object.objectKey,
      contentType: intent.expectedContentType,
      sourceEtag: head.etag,
    });
  } catch (error) {
    if (
      isStorageProviderError(error) &&
      error.failure === STORAGE_PROVIDER_FAILURE.PRECONDITION_FAILED
    ) {
      // The staged bytes changed under us. Whatever is there now was never
      // verified, so this upload is over.
      return reject(STORAGE_FAILURE_REASON.CHECKSUM_MISMATCH);
    }

    return releaseAndFail(error);
  }

  // The final object is read back rather than assumed. The copy reported
  // success, but the object a caller will download is this one, and its size is
  // the last opportunity to notice that the two differ.
  let finalHead: StorageObjectHead;

  try {
    finalHead = await provider.headObject(object.objectKey);
  } catch (error) {
    return releaseAndFail(error);
  }

  if (finalHead.sizeBytes !== Number(intent.expectedSizeBytes)) {
    return reject(STORAGE_FAILURE_REASON.SIZE_MISMATCH);
  }

  const completed = await completeUploadIntent({
    intentId: intent.id,
    objectId: intent.objectId,
    expectedVersion: intent.version,
    leaseTokenHash: claimed.leaseTokenHash,
    contentType: intent.expectedContentType,
    sizeBytes: Number(intent.expectedSizeBytes),
    checksumSha256: intent.expectedChecksumSha256,
    etag: finalHead.etag ?? finalEtag,
    inspection,
    now,
  });

  if (completed === null) {
    // The lease was reclaimed while this attempt was copying, so another
    // finalization owns the intent now. This one wrote a final object and must
    // not claim success — the object it wrote is byte-identical to what the
    // winner will write, because both copy the same verified source, and the
    // loser's is the one cleanup will not need to remove.
    throw new ConflictError("The upload intent is already being finalized.");
  }

  await deleteQuietly(provider, intent.stagingKey, logFields);

  const metadata = toStorageObjectMetadata(completed.object);

  if (metadata === null) {
    throw new ConflictError("The finalized object is not readable.");
  }

  logger.info(
    toStorageLogFields({
      ...logFields,
      policyName: intent.policyName,
      outcome: inspection,
      requestId: input.requestId,
    }),
    STORAGE_LOG_EVENT.UPLOAD_FINALIZED,
  );

  return { object: metadata };
}
