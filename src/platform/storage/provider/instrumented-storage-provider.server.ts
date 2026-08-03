import "server-only";

import {
  recordStorageFailure,
  SPAN_OUTCOME,
  withActiveSpan,
} from "@/platform/observability/index.server";

import {
  isStorageProviderError,
  type StorageProvider,
} from "./storage-provider";

/**
 * Telemetry for the storage boundary, applied by decorating the provider.
 *
 * It is a decorator rather than instrumentation inside the S3 adapter, and the
 * separation earns its keep twice: the adapter stays a pure translation of the
 * port onto one SDK, and telemetry stays deletable by removing one file and one
 * call. It also means every caller of the port is instrumented — there is no path
 * to the bucket that bypasses this.
 *
 * ## What a storage span may say
 *
 * The operation, the outcome, and the closed failure code. Nothing else, and the
 * list of what is excluded is longer than the list of what is included because
 * almost everything in scope here is either infrastructure or user data: the
 * bucket, the endpoint, the region, the object key, the staging key, the original
 * filename, the content type, the extension, the checksum, the signed URL, the
 * access key, the object id, and the upload intent id. An object key contains a
 * key prefix and an identifier; a signed URL contains a signature; a filename is
 * something a person typed.
 *
 * ## Why `checkBucket` is not here
 *
 * A health probe runs on a load balancer's schedule, which means it is the highest
 * frequency caller of the provider in any deployment and the one whose failures are
 * least interesting: a probe failing during a restart is not a business storage
 * failure. Instrumenting it would produce most of the spans and most of the failure
 * count, and would make `app.storage.failures` a graph of probe noise rather than
 * of uploads that did not work. So it is passed through untouched, and the health
 * platform reports on it through its own contract.
 */
export const STORAGE_OPERATION = {
  PRESIGN_UPLOAD: "storage.presign_upload",
  HEAD: "storage.head",
  STREAM: "storage.stream",
  COPY: "storage.copy",
  DELETE: "storage.delete",
  PRESIGN_DOWNLOAD: "storage.presign_download",
} as const;

export type StorageOperation =
  (typeof STORAGE_OPERATION)[keyof typeof STORAGE_OPERATION];

/** Every operation name, for the contract test that asserts the set is closed. */
export const STORAGE_OPERATIONS = Object.values(
  STORAGE_OPERATION,
) as readonly StorageOperation[];

export const STORAGE_SPAN_ATTRIBUTE = {
  OPERATION: "storage.operation",
  OUTCOME: "storage.outcome",
  FAILURE_CODE: "storage.failure.code",
} as const;

/**
 * The failure code recorded when the provider threw something that is not a
 * `StorageProviderError`.
 *
 * The adapter translates every provider failure into the closed set, so this is
 * reached only by a defect above it — and a defect must not be labelled with a
 * code that suggests the bucket refused something.
 */
export const UNCLASSIFIED_STORAGE_FAILURE = "unclassified";

function failureCode(error: unknown): string {
  return isStorageProviderError(error)
    ? error.failure
    : UNCLASSIFIED_STORAGE_FAILURE;
}

async function traced<T>(
  operation: StorageOperation,
  run: () => Promise<T>,
): Promise<T> {
  return withActiveSpan(
    operation,
    { [STORAGE_SPAN_ATTRIBUTE.OPERATION]: operation },
    async (span) => {
      try {
        const result = await run();

        span.setAttributes({
          [STORAGE_SPAN_ATTRIBUTE.OUTCOME]: SPAN_OUTCOME.SUCCEEDED,
        });
        span.setOutcome(SPAN_OUTCOME.SUCCEEDED);

        return result;
      } catch (error) {
        const code = failureCode(error);

        span.setAttributes({
          [STORAGE_SPAN_ATTRIBUTE.OUTCOME]: SPAN_OUTCOME.FAILED,
          [STORAGE_SPAN_ATTRIBUTE.FAILURE_CODE]: code,
        });
        span.setOutcome(SPAN_OUTCOME.FAILED, code);

        recordStorageFailure({ operation, failureCode: code });

        // The failure propagates unchanged. Telemetry observes a storage
        // operation; it never decides one.
        throw error;
      }
    },
  );
}

/**
 * Wraps a provider so its six data operations carry a span and a failure count.
 *
 * `destroy` and `checkBucket` are passed through: one is a teardown, the other is a
 * probe, and neither is a business storage operation.
 */
export function instrumentStorageProvider(
  provider: StorageProvider,
): StorageProvider {
  return {
    createPresignedUpload: (request) =>
      traced(STORAGE_OPERATION.PRESIGN_UPLOAD, () =>
        provider.createPresignedUpload(request),
      ),
    headObject: (key) =>
      traced(STORAGE_OPERATION.HEAD, () => provider.headObject(key)),
    computeObjectChecksum: (request) =>
      traced(STORAGE_OPERATION.STREAM, () =>
        provider.computeObjectChecksum(request),
      ),
    copyObjectConditionally: (request) =>
      traced(STORAGE_OPERATION.COPY, () =>
        provider.copyObjectConditionally(request),
      ),
    deleteObject: (key) =>
      traced(STORAGE_OPERATION.DELETE, () => provider.deleteObject(key)),
    createPresignedDownload: (request) =>
      traced(STORAGE_OPERATION.PRESIGN_DOWNLOAD, () =>
        provider.createPresignedDownload(request),
      ),
    checkBucket: () => provider.checkBucket(),
    destroy: () => provider.destroy(),
  };
}
