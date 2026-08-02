import "server-only";

import {
  DependencyUnavailableError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/application-error";

import { getStorageConfiguration } from "./config";
import { requireStorageProvider } from "./provider/storage-client.server";
import { isStorageProviderError } from "./provider/storage-provider";
import { toContentDisposition, isSafeDownloadFilename } from "./safe-filename";
import { findStorageObjectById } from "./storage-repository.server";
import { STORAGE_OBJECT_STATUS } from "./storage-object";

/**
 * A short-lived, private link to one ready object.
 *
 * Two things are deliberately *not* here, and both are the calling module's job:
 *
 * - Authentication and authorization. This function takes no actor and asks no
 *   question about one. The platform cannot know whether a given person may read
 *   a given file, because the relationship that would answer it — this object
 *   belongs to that invoice, which belongs to that customer — lives entirely in
 *   the module. A caller that forgets to check is the caller's defect, and the
 *   documentation says so plainly rather than pretending a `userId` parameter
 *   would have helped.
 * - Publication. There is no public URL, no ACL, and no CDN. Every download is a
 *   signature with an expiry measured in minutes.
 *
 * The returned URL is never stored and never logged. It is a bearer credential
 * for the length of its signature: anyone holding it can read the object, which
 * is exactly why it is short-lived and why it does not go into a log line where
 * it would outlive its own expiry by the retention period of the log.
 */
export type CreateStorageDownloadUrlInput = Readonly<{
  objectId: string;
  /** Clamped to the configured maximum. Defaults to the configured value. */
  ttlSeconds?: number;
  /** A name the caller chose. Never the original upload filename. */
  filename?: string;
  /**
   * Overrides the `Content-Type` the response is served with, and only within
   * what was verified: the object's own type. A caller cannot relabel a PDF as
   * `text/html`, which is the relabelling that turns a stored file into a
   * stored-XSS vector on the bucket's own origin.
   */
  contentType?: string;
}>;

export type StorageDownload = Readonly<{
  url: string;
  expiresAt: string;
}>;

export async function createStorageDownloadUrl(
  input: CreateStorageDownloadUrlInput,
): Promise<StorageDownload> {
  const configuration = getStorageConfiguration();

  if (!configuration.enabled) {
    throw new DependencyUnavailableError("Object storage is not enabled.");
  }

  if (input.filename !== undefined && !isSafeDownloadFilename(input.filename)) {
    throw new ValidationError("The download filename is not usable.");
  }

  const object = await findStorageObjectById(input.objectId);

  if (object === null) {
    throw new NotFoundError("The storage object does not exist.");
  }

  // Everything that is not ready is refused, and refused identically: pending,
  // rejected, expired, and quarantined all produce the same answer. A
  // quarantined object in particular must not be distinguishable here — the
  // difference between "no such file" and "that file was withheld" is
  // information about what somebody uploaded.
  if (object.status !== STORAGE_OBJECT_STATUS.READY) {
    throw new NotFoundError("The storage object is not available.");
  }

  if (
    input.contentType !== undefined &&
    input.contentType !== object.contentType
  ) {
    throw new ValidationError(
      "A download may only be served as the object's own media type.",
    );
  }

  const ttlSeconds = Math.min(
    input.ttlSeconds ?? configuration.downloadUrlTtlSeconds,
    configuration.downloadUrlTtlSeconds,
  );

  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new ValidationError("The download lifetime must be positive.");
  }

  const provider = requireStorageProvider();

  try {
    const url = await provider.createPresignedDownload({
      key: object.objectKey,
      expiresInSeconds: ttlSeconds,
      ...(object.contentType === null
        ? {}
        : { contentType: object.contentType }),
      ...(input.filename === undefined
        ? {}
        : { contentDisposition: toContentDisposition(input.filename) }),
    });

    return {
      url,
      expiresAt: new Date(Date.now() + ttlSeconds * 1_000).toISOString(),
    };
  } catch (error) {
    if (isStorageProviderError(error)) {
      throw new DependencyUnavailableError(
        "The storage provider is unavailable.",
      );
    }

    throw error;
  }
}
