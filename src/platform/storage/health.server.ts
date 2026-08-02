import "server-only";

import { startOperationTimer } from "@/platform/observability/operation-timer.server";

import { getStorageConfiguration } from "./config";
import { getStorageProvider } from "./provider/storage-client.server";
import {
  isStorageProviderError,
  STORAGE_PROVIDER_FAILURE,
} from "./provider/storage-provider";

/**
 * The storage health contract.
 *
 * Four outcomes, and the distinctions between them are the whole value:
 *
 * - `disabled` is a deployment choice and must never make an application look
 *   unhealthy. It is answered from configuration, so a readiness probe on a
 *   project that stores nothing costs no client, no socket, and no DNS lookup.
 * - `healthy` means the configured bucket answered.
 * - `misconfigured` means the provider answered and said no: the bucket does not
 *   exist, or the credentials are refused. Restarting will not fix it, and a
 *   readiness probe that retried forever would be waiting for a deploy.
 * - `unavailable` means it could not be reached or did not answer in time. That
 *   one is worth retrying.
 *
 * The result carries a status and a latency and nothing else. A health result is
 * the single most likely thing in a system to be rendered on a page or shipped
 * to a dashboard, so it is exactly where a bucket name, an endpoint, or a
 * provider message must not be able to reach.
 *
 * No route is added in this change. `checkStorageHealth` is the contract a
 * readiness endpoint will call.
 */
export const STORAGE_HEALTH_STATUS = {
  DISABLED: "disabled",
  HEALTHY: "healthy",
  UNAVAILABLE: "unavailable",
  MISCONFIGURED: "misconfigured",
} as const;

export type StorageHealthStatus =
  (typeof STORAGE_HEALTH_STATUS)[keyof typeof STORAGE_HEALTH_STATUS];

export type StorageHealth =
  | Readonly<{ status: typeof STORAGE_HEALTH_STATUS.DISABLED }>
  | Readonly<{
      status: typeof STORAGE_HEALTH_STATUS.HEALTHY;
      latencyMs: number;
    }>
  | Readonly<{ status: typeof STORAGE_HEALTH_STATUS.UNAVAILABLE }>
  | Readonly<{ status: typeof STORAGE_HEALTH_STATUS.MISCONFIGURED }>;

export async function checkStorageHealth(): Promise<StorageHealth> {
  let enabled: boolean;

  try {
    enabled = getStorageConfiguration().enabled;
  } catch {
    // Reading the configuration threw, which means the storage variables
    // themselves do not parse. That is a configuration fault and is reported as
    // one rather than crashing a probe. The thrown value is not read: a
    // validation error names the variables it rejected.
    return { status: STORAGE_HEALTH_STATUS.MISCONFIGURED };
  }

  if (!enabled) {
    return { status: STORAGE_HEALTH_STATUS.DISABLED };
  }

  const timer = startOperationTimer();

  try {
    const provider = getStorageProvider();

    if (provider === null) {
      return { status: STORAGE_HEALTH_STATUS.DISABLED };
    }

    // A bounded `HeadBucket`, which is a metadata call: it creates nothing,
    // writes nothing, and deletes nothing. A probe that round-tripped a test
    // object would be a probe that fills a bucket with garbage and fails when
    // the credentials are read-only.
    await provider.checkBucket();

    return {
      status: STORAGE_HEALTH_STATUS.HEALTHY,
      latencyMs: timer.elapsedMs(),
    };
  } catch (error) {
    if (isStorageProviderError(error)) {
      if (
        error.failure === STORAGE_PROVIDER_FAILURE.BUCKET_NOT_FOUND ||
        error.failure === STORAGE_PROVIDER_FAILURE.ACCESS_DENIED
      ) {
        return { status: STORAGE_HEALTH_STATUS.MISCONFIGURED };
      }
    }

    return { status: STORAGE_HEALTH_STATUS.UNAVAILABLE };
  }
}
