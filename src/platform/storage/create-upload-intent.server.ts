import "server-only";

import { logger } from "@/platform/observability/logger.server";
import { DependencyUnavailableError } from "@/shared/errors/application-error";

import { getStorageConfiguration, getStorageKeyScope } from "./config";
import {
  validateUploadFileDeclaration,
  type UploadFileDeclaration,
} from "./file-declaration";
import { createFinalizeToken, hashFinalizeToken } from "./finalize-token";
import { STORAGE_LOG_EVENT } from "./log-event";
import { requireStorageProvider } from "./provider/storage-client.server";
import type { PresignedUpload } from "./provider/storage-provider";
import { insertUploadIntent } from "./storage-repository.server";
import { STORAGE_NAMESPACE, buildStorageKey } from "./storage-key";
import { toStorageLogFields } from "./storage-log-fields";
import type { UploadPolicy } from "./upload-policy";

/**
 * What the caller receives, and the complete list of it.
 *
 * The bucket is not here. Nor is the final object key, the endpoint, the
 * provider name, any credential, the finalize token's hash, or the database
 * row. The client gets a form it can post once and a token it can finalize
 * with, and learns nothing about where the object will live — which is what
 * makes the final object unaddressable by the party that uploaded it.
 *
 * `finalizeToken` is the one secret in this object, and it is returned exactly
 * once. The calling module is responsible for getting it back to whoever will
 * finalize; the platform keeps only its hash.
 */
export type CreatedUploadIntent = Readonly<{
  intentId: string;
  objectId: string;
  expiresAt: string;
  finalizeToken: string;
  upload: PresignedUpload;
}>;

export type CreateUploadIntentInput = Readonly<{
  policy: UploadPolicy;
  file: UploadFileDeclaration;
  /** The identifier of the request that asked for this, when there is one. */
  requestId?: string;
  /** Injectable so a test can reason about expiry without waiting for it. */
  now?: Date;
}>;

/**
 * Authorizes exactly one upload of exactly one file.
 *
 * The order matters and is not incidental. The declaration is validated first,
 * so an oversized or disallowed file costs a validation error and nothing else —
 * no row, no key, no provider call. The row is written before the presigned form
 * is created, so a form can never exist for an intent that failed to persist; the
 * opposite order would leave a client able to upload into staging with nothing
 * in the database that knows the object is there.
 *
 * A failure to sign the form leaves a `pending` intent behind. That is
 * deliberate rather than sloppy: it expires on its own, and the cleanup contract
 * removes it. Rolling it back would mean a second write on the failure path of a
 * dependency that is already failing.
 */
export async function createUploadIntent(
  input: CreateUploadIntentInput,
): Promise<CreatedUploadIntent> {
  const configuration = getStorageConfiguration();

  if (!configuration.enabled) {
    throw new DependencyUnavailableError("Object storage is not enabled.");
  }

  const declaration = validateUploadFileDeclaration(
    input.file,
    input.policy,
    configuration.maxUploadBytes,
  );

  const provider = requireStorageProvider();
  const scope = getStorageKeyScope();
  const now = input.now ?? new Date();

  // Two independent random keys rather than one derived from the other. The
  // client sees the staging key inside its upload form; if the final key could
  // be computed from it, the guarantee that the client cannot address the final
  // object would rest on the provider's access control alone.
  const stagingKey = buildStorageKey(scope, STORAGE_NAMESPACE.STAGING);
  const objectKey = buildStorageKey(scope, STORAGE_NAMESPACE.OBJECTS);

  const finalizeToken = createFinalizeToken();
  const expiresAt = new Date(
    now.getTime() + configuration.uploadIntentTtlSeconds * 1_000,
  );

  const { object, intent } = await insertUploadIntent({
    objectKey,
    stagingKey,
    finalizeTokenHash: hashFinalizeToken(finalizeToken),
    policyName: input.policy.name,
    declaredExtension: declaration.extension,
    expectedContentType: declaration.contentType,
    expectedSizeBytes: declaration.sizeBytes,
    expectedChecksumSha256: declaration.checksumSha256,
    expiresAt,
  });

  // The form's lifetime is the shorter of the two by configuration, and it is
  // clamped again here: a form that outlived its intent would let bytes land in
  // staging that nothing is left to promote.
  const uploadTtlSeconds = Math.min(
    configuration.uploadUrlTtlSeconds,
    configuration.uploadIntentTtlSeconds,
  );

  const upload = await provider.createPresignedUpload({
    key: stagingKey,
    contentType: declaration.contentType,
    sizeBytes: declaration.sizeBytes,
    checksumSha256: declaration.checksumSha256,
    expiresInSeconds: uploadTtlSeconds,
  });

  logger.info(
    toStorageLogFields({
      intentId: intent.id,
      objectId: object.id,
      policyName: input.policy.name,
      requestId: input.requestId,
    }),
    STORAGE_LOG_EVENT.UPLOAD_INTENT_CREATED,
  );

  return {
    intentId: intent.id,
    objectId: object.id,
    expiresAt: intent.expiresAt.toISOString(),
    finalizeToken,
    upload,
  };
}
