import { serverEnv } from "@/config/env/index.server";
import { readStorageEnvironment } from "@/config/env/read-storage";
import type { StorageEnvironment } from "@/config/env/schema";

import type { StorageKeyScope } from "./storage-key";

/**
 * The resolved object storage configuration, read lazily.
 *
 * Nothing here runs at import time. A module that imports this file does not
 * read the environment, does not validate an endpoint, does not construct an S3
 * client, and does not resolve a hostname; all of that waits for the first call
 * that genuinely needs a bucket. That is what makes storage optional rather than
 * optional-in-principle, and it is the property `pnpm verify` proves on a
 * machine with no MinIO anywhere.
 *
 * The type is a discriminated union so a caller that has checked `enabled` gets
 * the bucket without a non-null assertion, and a caller that has not cannot
 * reach it at all. The disabled arm carries only the values that are meaningful
 * without a provider — the limits a policy is validated against — and no
 * endpoint, no bucket, and no credentials.
 */
export type StorageCredentials = Readonly<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}>;

export type StorageLimits = Readonly<{
  keyPrefix: string;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
  uploadIntentTtlSeconds: number;
  finalizeLeaseMs: number;
  maxUploadBytes: number;
}>;

export type StorageConfiguration =
  | (Readonly<{ enabled: false }> & StorageLimits)
  | (Readonly<{
      enabled: true;
      region: string;
      bucket: string;
      endpoint?: string;
      forcePathStyle: boolean;
      /**
       * Absent when no key pair was configured, which selects the AWS default
       * credential chain — an instance role, a web identity, a shared profile.
       * Half a pair never reaches here: the schema refuses it.
       */
      credentials?: StorageCredentials;
    }> &
      StorageLimits);

function toLimits(environment: StorageEnvironment): StorageLimits {
  return {
    keyPrefix: environment.STORAGE_KEY_PREFIX,
    connectTimeoutMs: environment.STORAGE_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: environment.STORAGE_REQUEST_TIMEOUT_MS,
    uploadUrlTtlSeconds: environment.STORAGE_UPLOAD_URL_TTL_SECONDS,
    downloadUrlTtlSeconds: environment.STORAGE_DOWNLOAD_URL_TTL_SECONDS,
    uploadIntentTtlSeconds: environment.STORAGE_UPLOAD_INTENT_TTL_SECONDS,
    finalizeLeaseMs: environment.STORAGE_FINALIZE_LEASE_MS,
    maxUploadBytes: environment.STORAGE_MAX_UPLOAD_BYTES,
  };
}

function toCredentials(
  environment: StorageEnvironment,
): StorageCredentials | undefined {
  if (
    environment.STORAGE_ACCESS_KEY_ID === undefined ||
    environment.STORAGE_SECRET_ACCESS_KEY === undefined
  ) {
    return undefined;
  }

  return {
    accessKeyId: environment.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: environment.STORAGE_SECRET_ACCESS_KEY,
    ...(environment.STORAGE_SESSION_TOKEN === undefined
      ? {}
      : { sessionToken: environment.STORAGE_SESSION_TOKEN }),
  };
}

function toConfiguration(
  environment: StorageEnvironment,
): StorageConfiguration {
  const limits = toLimits(environment);

  // The region and bucket are guaranteed by the schema once the flag is on; the
  // checks are repeated so the narrowing is established by code rather than
  // asserted.
  if (
    !environment.STORAGE_ENABLED ||
    environment.STORAGE_REGION === undefined ||
    environment.STORAGE_BUCKET === undefined
  ) {
    return { enabled: false, ...limits };
  }

  const credentials = toCredentials(environment);

  return {
    enabled: true,
    region: environment.STORAGE_REGION,
    bucket: environment.STORAGE_BUCKET,
    ...(environment.STORAGE_ENDPOINT === undefined
      ? {}
      : { endpoint: environment.STORAGE_ENDPOINT }),
    forcePathStyle: environment.STORAGE_FORCE_PATH_STYLE,
    ...(credentials === undefined ? {} : { credentials }),
    ...limits,
  };
}

type StorageState = {
  configuration?: StorageConfiguration;
  keyScope?: StorageKeyScope;
};

/**
 * Memoized per process, and held on `globalThis` for the same reason the Prisma
 * client is: a development reload re-evaluates the module, and a second key
 * scope would give the reloaded code a different namespace from the keys
 * already written.
 */
const globalForStorageConfig = globalThis as typeof globalThis & {
  storageConfigurationState?: StorageState;
};

function state(): StorageState {
  globalForStorageConfig.storageConfigurationState ??= {};

  return globalForStorageConfig.storageConfigurationState;
}

export function getStorageConfiguration(): StorageConfiguration {
  const current = state();

  current.configuration ??= toConfiguration(readStorageEnvironment());

  return current.configuration;
}

/** `true` only when storage is explicitly enabled. Never builds a client. */
export function isStorageEnabled(): boolean {
  return getStorageConfiguration().enabled;
}

/**
 * The key scope of this process.
 *
 * Under test a run identifier is always present: one is taken from
 * `STORAGE_TEST_RUN_ID` when the runner supplies it, and generated otherwise, so
 * two runs against the same bucket — including two CI runs — can never write
 * into, read, or delete each other's keys.
 */
export function getStorageKeyScope(): StorageKeyScope {
  const current = state();

  if (current.keyScope) {
    return current.keyScope;
  }

  const environment = readStorageEnvironment();
  const appEnvironment = serverEnv.APP_ENV;

  const scope: StorageKeyScope =
    appEnvironment === "test"
      ? {
          prefix: environment.STORAGE_KEY_PREFIX,
          environment: appEnvironment,
          testRunId: environment.STORAGE_TEST_RUN_ID ?? generateTestRunId(),
        }
      : {
          prefix: environment.STORAGE_KEY_PREFIX,
          environment: appEnvironment,
        };

  current.keyScope = scope;

  return scope;
}

function generateTestRunId(): string {
  return `run-${crypto.randomUUID()}`;
}

/**
 * Drops the memoized configuration and key scope.
 *
 * Exported for tests that change the environment between cases, and for nothing
 * else: application code reads one configuration for the lifetime of a process.
 */
export function resetStorageConfiguration(): void {
  delete globalForStorageConfig.storageConfigurationState;
}
