import "server-only";

import { DependencyUnavailableError } from "@/shared/errors/application-error";

import { getStorageConfiguration } from "../config";

import { createS3StorageProvider } from "./s3-storage-provider.server";
import type { StorageProvider } from "./storage-provider";

/**
 * The lazy, server-only storage provider.
 *
 * Nothing is constructed at import time and nothing at startup. The first
 * caller that genuinely needs the bucket builds the client; a process that never
 * calls one of these functions never resolves the endpoint's hostname, never
 * opens a socket, and never reads a credential. That is the property the whole
 * area is arranged around, and it is what `pnpm verify` proves on a machine with
 * no MinIO installed.
 *
 * One client per process, held on `globalThis` so a development reload reuses it
 * rather than leaking a connection pool per reload.
 */
type StorageProviderState = {
  provider?: StorageProvider;
};

const globalForStorageProvider = globalThis as typeof globalThis & {
  storageProviderState?: StorageProviderState;
};

function state(): StorageProviderState {
  globalForStorageProvider.storageProviderState ??= {};

  return globalForStorageProvider.storageProviderState;
}

/**
 * The provider, or `null` when storage is disabled.
 *
 * `null` means "not configured", and nothing else. There is no "enabled but
 * unreachable" answer here, because building the client contacts nothing:
 * unreachability is discovered by the first call that uses it, which is where
 * it can be reported as the failure of a specific operation.
 */
export function getStorageProvider(): StorageProvider | null {
  const configuration = getStorageConfiguration();

  if (!configuration.enabled) {
    return null;
  }

  const current = state();

  current.provider ??= createS3StorageProvider(configuration);

  return current.provider;
}

/**
 * The provider. Refuses when storage is disabled.
 *
 * `DependencyUnavailableError` rather than an internal error, because a caller
 * asking to store a file on a deployment with no storage configured has not hit
 * a defect: the operation was refused before anything happened, nothing was
 * written, and the same call would succeed on a deployment that has a bucket.
 */
export function requireStorageProvider(): StorageProvider {
  const provider = getStorageProvider();

  if (!provider) {
    throw new DependencyUnavailableError("Object storage is not enabled.");
  }

  return provider;
}

/**
 * Releases the client's sockets and forgets it.
 *
 * For tests and for an explicit shutdown. No signal handler is registered here:
 * a platform module that installed one would be deciding the process's shutdown
 * behaviour on behalf of every host that ever imports it.
 */
export function closeStorageClient(): void {
  const current = state();
  const provider = current.provider;

  current.provider = undefined;

  provider?.destroy();
}
