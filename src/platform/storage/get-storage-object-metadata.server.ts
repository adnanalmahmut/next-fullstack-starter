import "server-only";

import { findStorageObjectById } from "./storage-repository.server";
import {
  toStorageObjectMetadata,
  type StorageObjectMetadata,
} from "./storage-object";

/**
 * What a module may know about an object it stored.
 *
 * PostgreSQL alone: no provider call, no signature, no socket. Everything a
 * caller needs to render "invoice.pdf, 240 KB" was verified at finalization and
 * written down then, so asking the bucket again would cost a round trip to learn
 * something already known.
 *
 * `null` for anything that is not ready. The same answer for an object that
 * never existed, one still pending, one rejected, and one quarantined — because
 * the caller's next action is identical in all four cases, and distinguishing
 * them here would leak whether a particular identifier corresponds to a file
 * that was withheld.
 */
export async function getStorageObjectMetadata(
  objectId: string,
): Promise<StorageObjectMetadata | null> {
  const object = await findStorageObjectById(objectId);

  return object === null ? null : toStorageObjectMetadata(object);
}
