import { createHash, randomUUID } from "node:crypto";

import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetBucketPolicyCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

import type { PresignedUpload } from "@/platform/storage/index.server";

/**
 * Test-side object storage helpers.
 *
 * Three of these deliberately do not exist in the platform, and their absence
 * there is the point. Creating a bucket, listing a prefix, and deleting many
 * objects at once are all capabilities production code has no reason to hold —
 * a platform that could list the bucket could enumerate every object in it, and
 * a platform that could delete by prefix could delete a customer's files with
 * one wrong variable. The tests need them, so they live here, behind a client
 * the tests build for themselves.
 *
 * Every helper works under the run's own key prefix and nothing wider, so two
 * suites, or two CI runs, sharing one bucket cannot see or erase each other's
 * objects.
 */
export type StorageTestTarget = Readonly<{
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}>;

/**
 * Reads the target from the environment and refuses anything that is not a
 * local test object store.
 *
 * The host check is the important one. A suite that creates buckets, uploads
 * objects, and deletes by prefix must never be able to run against a deployed
 * provider because of one wrong variable in a shell.
 */
export function readStorageTestTarget(): StorageTestTarget {
  const endpoint = process.env.STORAGE_ENDPOINT ?? "";
  const url = new URL(endpoint === "" ? "http://invalid.example" : endpoint);

  if (!["127.0.0.1", "localhost", "::1", "minio"].includes(url.hostname)) {
    throw new Error(
      "The storage integration suite refuses to run against a non-local endpoint.",
    );
  }

  if (process.env.APP_ENV !== "test") {
    throw new Error("The storage integration suite requires APP_ENV=test.");
  }

  if (process.env.STORAGE_ENABLED !== "true") {
    throw new Error(
      "The storage integration suite requires STORAGE_ENABLED=true.",
    );
  }

  const bucket = process.env.STORAGE_BUCKET ?? "";
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID ?? "";
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY ?? "";

  if (bucket === "" || accessKeyId === "" || secretAccessKey === "") {
    throw new Error(
      "The storage integration suite needs a bucket and a test credential pair.",
    );
  }

  return {
    endpoint,
    region: process.env.STORAGE_REGION ?? "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
  };
}

export function createStorageTestClient(target: StorageTestTarget): S3Client {
  return new S3Client({
    region: target.region,
    endpoint: target.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
    },
    maxAttempts: 3,
  });
}

/**
 * Makes sure the bucket exists, without depending on anyone having made it.
 *
 * Idempotent, because a suite that failed halfway leaves the bucket behind and
 * the next run must not care. No bucket policy is ever applied: a bucket with no
 * policy is private, and the one thing this project must never do is make one
 * public.
 */
export async function ensureTestBucket(
  client: S3Client,
  bucket: string,
): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));

    return;
  } catch {
    // Not there, or not visible. Creating it answers both.
  }

  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    // Another worker created it between the head and the create.
    const name = (error as { name?: string }).name ?? "";

    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") {
      throw error;
    }
  }
}

/**
 * `true` when the bucket grants anonymous access.
 *
 * Asserted to be `false` by the suite. A provider that has no policy answers
 * with an error, which is the healthy case.
 */
export async function bucketAllowsAnonymousAccess(
  client: S3Client,
  bucket: string,
): Promise<boolean> {
  try {
    const response = await client.send(
      new GetBucketPolicyCommand({ Bucket: bucket }),
    );

    const policy = response.Policy ?? "";

    return policy.includes('"AWS":"*"') || policy.includes('"Principal":"*"');
  } catch {
    return false;
  }
}

/** Every key under one prefix, sorted for stable assertions. */
export async function listKeysUnderPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ...(continuationToken === undefined ? {} : { continuationToken }),
      }),
    );

    for (const item of response.Contents ?? []) {
      if (item.Key !== undefined) {
        keys.push(item.Key);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken !== undefined);

  return keys.sort();
}

/**
 * Removes every object under one prefix.
 *
 * The prefix comes from the run's own key scope, so a run can only delete what
 * it created. The bucket itself is never deleted: it is shared with whatever
 * else is using this object store.
 */
export async function deleteKeysUnderPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<number> {
  const keys = await listKeysUnderPrefix(client, bucket, prefix);

  if (keys.length === 0) {
    return 0;
  }

  for (let index = 0; index < keys.length; index += 1000) {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: keys.slice(index, index + 1000).map((Key) => ({ Key })),
        },
      }),
    );
  }

  return keys.length;
}

/**
 * Posts bytes to a presigned form, exactly as a browser would.
 *
 * `fetch` with `FormData` and nothing else — no SDK, no signature, no
 * credential. That is the point of the whole design: the only thing the client
 * needs is the form the server signed, and if this helper needed anything more
 * then a browser would too.
 */
export async function postPresignedUpload(
  upload: PresignedUpload,
  body: Uint8Array,
  overrides: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const form = new FormData();

  for (const [name, value] of Object.entries(upload.fields)) {
    form.append(name, overrides[name] ?? value);
  }

  for (const [name, value] of Object.entries(overrides)) {
    if (!(name in upload.fields)) {
      form.append(name, value);
    }
  }

  form.append("file", new Blob([body as BlobPart]));

  return fetch(upload.url, { method: upload.method, body: form });
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Deterministic-looking bytes that are unique per call. */
export function testBytes(size: number): Uint8Array {
  const seed = Buffer.from(randomUUID(), "utf8");
  const bytes = Buffer.alloc(size);

  for (let index = 0; index < size; index += 1) {
    bytes[index] = seed[index % seed.length] ?? 0;
  }

  return new Uint8Array(bytes);
}
