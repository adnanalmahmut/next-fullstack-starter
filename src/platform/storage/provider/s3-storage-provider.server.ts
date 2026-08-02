import "server-only";

import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { sha256Base64ToHex, sha256HexToBase64 } from "../checksum";
import type { StorageConfiguration } from "../config";
import { assertValidStorageKey } from "../storage-key";

import {
  STORAGE_PROVIDER_FAILURE,
  StorageProviderError,
  type ConditionalCopyRequest,
  type PresignedDownloadRequest,
  type PresignedUpload,
  type PresignedUploadRequest,
  type ReadObjectRequest,
  type StorageObjectHead,
  type StorageProvider,
} from "./storage-provider";

/**
 * The one S3-compatible adapter.
 *
 * It is one adapter rather than three because AWS S3, Cloudflare R2, and MinIO
 * differ in configuration, not in protocol: an endpoint, a region, and whether
 * the bucket is addressed in the path or the hostname. A second SDK per provider
 * would give three code paths for one wire format, and two of them would be
 * exercised only in production.
 *
 * Every `@aws-sdk/*` import in the repository is in this file. Above it the
 * platform speaks `StorageProvider`, so replacing the SDK, or the provider, is
 * a change to one directory.
 *
 * Three rules hold throughout, and they are the reason to read this file
 * carefully rather than the reason to skim it:
 *
 * - No ACL is ever sent. Not `public-read`, not `private`, not any value: the
 *   bucket's own default applies, and a bucket that must be private is made
 *   private by the operator rather than argued about per request.
 * - Every call is bounded. The client carries connect and request timeouts and
 *   a small retry budget, and the streaming read carries a byte ceiling as well,
 *   because a `Content-Length` is a claim like any other.
 * - No raw provider error escapes. Everything is translated into
 *   `StorageProviderError` with a code from a closed set, which is what keeps a
 *   bucket name, an endpoint, a signed URL, or an AWS request identifier out of
 *   the layers above.
 */

/**
 * A small, finite retry budget.
 *
 * Three attempts is the SDK's own default, and it is kept rather than raised: a
 * presigned upload is created inside a request the user is waiting on, and a
 * finalization holds a lease while it runs. Retrying longer would not make
 * either succeed; it would make both hold on to something for longer.
 */
const MAX_PROVIDER_ATTEMPTS = 3;

type S3Like = Readonly<{
  name?: string;
  $metadata?: { httpStatusCode?: number };
}>;

/**
 * Translates a provider failure into one of five codes.
 *
 * The mapping reads the error *name* and the HTTP status, and nothing else. In
 * particular it never reads `error.message`: a provider message is where the
 * bucket name and the endpoint live, and the surest way not to log one is not to
 * hold one.
 */
function toProviderFailure(error: unknown, notFoundIsMissingObject: boolean) {
  const candidate = error as S3Like;
  const name = candidate.name ?? "";
  const status = candidate.$metadata?.httpStatusCode;

  if (name === "NoSuchBucket") {
    return STORAGE_PROVIDER_FAILURE.BUCKET_NOT_FOUND;
  }

  if (name === "NoSuchKey") {
    return STORAGE_PROVIDER_FAILURE.NOT_FOUND;
  }

  // `HeadBucket` and `HeadObject` both answer a bare `NotFound` with no body,
  // so the name alone cannot say which one is missing. The caller knows —
  // there is a key in the request or there is not — which is what the flag
  // carries. Reading it the other way would report a missing bucket as a
  // missing object, and a health check would call a misconfiguration a
  // transient outage.
  if (name === "NotFound" || status === 404) {
    return notFoundIsMissingObject
      ? STORAGE_PROVIDER_FAILURE.NOT_FOUND
      : STORAGE_PROVIDER_FAILURE.BUCKET_NOT_FOUND;
  }

  if (name === "PreconditionFailed" || status === 412) {
    return STORAGE_PROVIDER_FAILURE.PRECONDITION_FAILED;
  }

  if (
    name === "AccessDenied" ||
    name === "InvalidAccessKeyId" ||
    name === "SignatureDoesNotMatch" ||
    status === 401 ||
    status === 403
  ) {
    return STORAGE_PROVIDER_FAILURE.ACCESS_DENIED;
  }

  return STORAGE_PROVIDER_FAILURE.UNAVAILABLE;
}

function fail(error: unknown, notFoundIsMissingObject: boolean): never {
  if (error instanceof StorageProviderError) {
    throw error;
  }

  throw new StorageProviderError(
    toProviderFailure(error, notFoundIsMissingObject),
  );
}

/**
 * The deadline every provider call runs under.
 *
 * The SDK's own `requestTimeout` covers a socket that stalls; this covers the
 * whole operation including retries and the time spent between them, which is
 * what a caller holding a lease actually cares about. The controller is aborted
 * in `finally`, so a call that resolved does not leave a timer or a half-open
 * request behind.
 *
 * That last part is why the whole of `run` matters and not only the `send`
 * inside it. `GetObject` resolves as soon as the response *headers* arrive,
 * with the body still unread; aborting there would tear down the stream the
 * caller is about to consume. So a streaming operation reads inside `run`
 * rather than after it, and gets one deadline covering headers and body
 * together — which is also the only bound that means anything for a body that
 * arrives slowly.
 */
async function withDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function normalizeEtag(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  // S3 quotes the entity tag in the header and expects it quoted back on a
  // conditional request, so the quotes are stripped once here and added once
  // where the condition is built, rather than being carried through the
  // database and half-handled in two places.
  const unquoted = value.replaceAll('"', "");

  return unquoted.length === 0 ? null : unquoted;
}

type EnabledStorageConfiguration = Extract<
  StorageConfiguration,
  { enabled: true }
>;

export function createS3StorageProvider(
  configuration: EnabledStorageConfiguration,
): StorageProvider {
  const { bucket } = configuration;

  const client = new S3Client({
    region: configuration.region,
    ...(configuration.endpoint === undefined
      ? {}
      : { endpoint: configuration.endpoint }),
    forcePathStyle: configuration.forcePathStyle,
    // Absent credentials are not a mistake here: leaving the field off selects
    // the SDK's default credential chain, which is how a deployment on AWS
    // authenticates with an instance role instead of a stored key pair.
    ...(configuration.credentials === undefined
      ? {}
      : { credentials: configuration.credentials }),
    maxAttempts: MAX_PROVIDER_ATTEMPTS,
    requestHandler: {
      connectionTimeout: configuration.connectTimeoutMs,
      requestTimeout: configuration.requestTimeoutMs,
    },
  });

  async function headObject(key: string): Promise<StorageObjectHead> {
    assertValidStorageKey(key);

    try {
      const response = await withDeadline(
        configuration.requestTimeoutMs,
        (signal) =>
          client.send(
            new HeadObjectCommand({
              Bucket: bucket,
              Key: key,
              // Asks the provider for the checksum it stored, when it stored
              // one. A provider that ignores this simply answers without it,
              // and the platform falls back to computing its own.
              ChecksumMode: "ENABLED",
            }),
            { abortSignal: signal },
          ),
      );

      const size = response.ContentLength;

      if (size === undefined) {
        throw new StorageProviderError(STORAGE_PROVIDER_FAILURE.UNAVAILABLE);
      }

      return {
        sizeBytes: size,
        contentType: response.ContentType ?? null,
        etag: normalizeEtag(response.ETag),
        checksumSha256:
          response.ChecksumSHA256 === undefined
            ? null
            : sha256Base64ToHex(response.ChecksumSHA256),
      };
    } catch (error) {
      return fail(error, true);
    }
  }

  return {
    async createPresignedUpload(
      request: PresignedUploadRequest,
    ): Promise<PresignedUpload> {
      assertValidStorageKey(request.key);

      try {
        // A presigned POST rather than a presigned PUT, and the difference is
        // the whole security argument. A presigned PUT signs a URL and accepts
        // whatever body arrives at it; a POST signs a *policy*, and the provider
        // refuses the upload itself when a condition is not met. That is what
        // makes the size limit real: `content-length-range` is checked by the
        // provider before the object exists, so an oversized upload never
        // becomes a stored object that somebody has to clean up.
        //
        // The conditions are exact rather than generous. One key, one content
        // type, and one size — not a maximum, the declared value — so the form
        // authorizes precisely the upload that was asked for and nothing that
        // merely resembles it.
        const presigned = await createPresignedPost(client, {
          Bucket: bucket,
          Key: request.key,
          Expires: request.expiresInSeconds,
          Fields: {
            "Content-Type": request.contentType,
            "x-amz-checksum-algorithm": "SHA256",
            "x-amz-checksum-sha256": sha256HexToBase64(request.checksumSha256),
          },
          Conditions: [
            ["eq", "$key", request.key],
            ["eq", "$Content-Type", request.contentType],
            ["content-length-range", request.sizeBytes, request.sizeBytes],
            ["eq", "$x-amz-checksum-algorithm", "SHA256"],
            [
              "eq",
              "$x-amz-checksum-sha256",
              sha256HexToBase64(request.checksumSha256),
            ],
          ],
        });

        return {
          method: "POST",
          url: presigned.url,
          fields: Object.freeze({ ...presigned.fields }),
        };
      } catch (error) {
        return fail(error, false);
      }
    },

    headObject,

    async computeObjectChecksum(request: ReadObjectRequest): Promise<string> {
      assertValidStorageKey(request.key);

      try {
        return await withDeadline(
          configuration.requestTimeoutMs,
          async (signal) => {
            const response = await client.send(
              new GetObjectCommand({ Bucket: bucket, Key: request.key }),
              { abortSignal: signal },
            );

            const body = response.Body as Readable | undefined;

            if (!body) {
              throw new StorageProviderError(
                STORAGE_PROVIDER_FAILURE.NOT_FOUND,
              );
            }

            const hash = createHash("sha256");
            let read = 0;

            try {
              for await (const chunk of body) {
                const bytes = chunk as Buffer;

                read += bytes.byteLength;

                // The ceiling is checked before the chunk is hashed and the
                // loop is left immediately, so an object larger than the
                // declaration — including one whose `Content-Length` lied —
                // costs one chunk of memory rather than its whole size.
                if (read > request.maxBytes) {
                  throw new StorageProviderError(
                    STORAGE_PROVIDER_FAILURE.PRECONDITION_FAILED,
                  );
                }

                hash.update(bytes);
              }
            } finally {
              // The response body holds a socket. Leaving it open on the
              // failure path is how a connection pool runs out under exactly
              // the conditions that produced the failure.
              body.destroy();
            }

            return hash.digest("hex");
          },
        );
      } catch (error) {
        return fail(error, true);
      }
    },

    async copyObjectConditionally(
      request: ConditionalCopyRequest,
    ): Promise<string> {
      assertValidStorageKey(request.sourceKey);
      assertValidStorageKey(request.destinationKey);

      try {
        const response = await withDeadline(
          configuration.requestTimeoutMs,
          (signal) =>
            client.send(
              new CopyObjectCommand({
                Bucket: bucket,
                Key: request.destinationKey,
                CopySource: `${bucket}/${request.sourceKey}`,
                CopySourceIfMatch: `"${request.sourceEtag}"`,
                ContentType: request.contentType,
                MetadataDirective: "REPLACE",
                ChecksumAlgorithm: "SHA256",
              }),
              { abortSignal: signal },
            ),
        );

        const etag = normalizeEtag(response.CopyObjectResult?.ETag);

        if (etag === null) {
          throw new StorageProviderError(STORAGE_PROVIDER_FAILURE.UNAVAILABLE);
        }

        return etag;
      } catch (error) {
        // A copy whose source is gone and a copy whose precondition failed are
        // both "the source is not what we verified", and both must stop the
        // promotion; the distinction is preserved because only one of them is
        // worth retrying.
        return fail(error, true);
      }
    },

    async deleteObject(key: string): Promise<void> {
      assertValidStorageKey(key);

      try {
        await withDeadline(configuration.requestTimeoutMs, (signal) =>
          client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
            abortSignal: signal,
          }),
        );
      } catch (error) {
        fail(error, true);
      }
    },

    async createPresignedDownload(
      request: PresignedDownloadRequest,
    ): Promise<string> {
      assertValidStorageKey(request.key);

      try {
        // Signing is a local computation: `getSignedUrl` builds and signs the
        // request without contacting the provider, so this call opens no socket
        // and cannot time out. That is also why an expired or revoked object is
        // not detected here — the platform checks the object's state in
        // PostgreSQL before it ever gets this far.
        return await getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: bucket,
            Key: request.key,
            ...(request.contentType === undefined
              ? {}
              : { ResponseContentType: request.contentType }),
            ...(request.contentDisposition === undefined
              ? {}
              : { ResponseContentDisposition: request.contentDisposition }),
          }),
          { expiresIn: request.expiresInSeconds },
        );
      } catch (error) {
        return fail(error, false);
      }
    },

    async checkBucket(): Promise<void> {
      try {
        await withDeadline(configuration.connectTimeoutMs, (signal) =>
          client.send(new HeadBucketCommand({ Bucket: bucket }), {
            abortSignal: signal,
          }),
        );
      } catch (error) {
        // `HeadBucket` answers 404 for a bucket that is not there, and the
        // adapter must not read that as a missing object: there is no key in
        // this request, so the second argument is `false` and the 404 maps to
        // `bucket-not-found`.
        fail(error, false);
      }
    },

    destroy(): void {
      client.destroy();
    },
  };
}
