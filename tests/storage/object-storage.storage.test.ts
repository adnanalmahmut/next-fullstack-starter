import { PutObjectCommand } from "@aws-sdk/client-s3";
import { loadEnvConfig } from "@next/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  StorageContentInspector,
  StorageInspectionVerdict,
} from "@/platform/storage/index.server";

loadEnvConfig(process.cwd());

const {
  bucketAllowsAnonymousAccess,
  createStorageTestClient,
  deleteKeysUnderPrefix,
  ensureTestBucket,
  listKeysUnderPrefix,
  postPresignedUpload,
  readStorageTestTarget,
  sha256Hex,
  testBytes,
} = await import("../fixtures/storage.fixture");

const {
  checkStorageHealth,
  cleanupExpiredUploadIntents,
  closeStorageClient,
  createStorageDownloadUrl,
  createUploadIntent,
  defineUploadPolicy,
  finalizeUploadIntent,
  getStorageObjectMetadata,
  INSPECTION_OUTCOME,
  STORAGE_HEALTH_STATUS,
  STORAGE_INSPECTION_RESULT,
  UPLOAD_INSPECTION,
} = await import("@/platform/storage/index.server");

const { getStorageKeyScope, resetStorageConfiguration } =
  await import("@/platform/storage/config");
const { storageScopePrefix } = await import("@/platform/storage/storage-key");
const { database } = await import("@/platform/database/index.server");

/**
 * The upload lifecycle against a real S3-compatible object store.
 *
 * This suite is not part of `pnpm verify`. It is reached only through
 * `pnpm test:storage:integration`, which is what keeps an object store from
 * becoming a requirement for building or testing the application.
 *
 * What is being tested here cannot be tested any other way. A presigned POST
 * policy is enforced by the provider, not by this code: whether an oversized
 * body is refused, whether a tampered key is refused, and whether a conditional
 * copy actually holds its precondition are all facts about MinIO's
 * implementation of the S3 protocol. A mock would assert what this repository
 * believes about S3 rather than what S3 does.
 *
 * Every object it writes lives under this run's own key prefix, and cleanup
 * lists that prefix alone: two runs against one bucket, including two CI runs,
 * cannot see or delete each other's objects.
 */
const target = readStorageTestTarget();
const testClient = createStorageTestClient(target);
const scope = getStorageKeyScope();
const runPrefix = storageScopePrefix(scope);

/**
 * A sentinel belonging to a different run.
 *
 * Written once, never touched by anything the platform does, and asserted to
 * still be there at the end. It is what turns "cleanup is scoped" from a claim
 * about the code into an observation about the bucket.
 */
const foreignKey = `${scope.prefix}/${scope.environment}/run-not-ours/objects/sentinel-object`;

const pdfPolicy = defineUploadPolicy({
  name: "test.document",
  allowedFiles: [
    { contentType: "application/pdf", extensions: ["pdf"] },
    { contentType: "image/png", extensions: ["png"] },
  ],
  maxBytes: 1024 * 1024,
});

const scannedPolicy = defineUploadPolicy({
  name: "test.scanned",
  allowedFiles: [{ contentType: "application/pdf", extensions: ["pdf"] }],
  maxBytes: 1024 * 1024,
  inspection: UPLOAD_INSPECTION.REQUIRED,
});

/**
 * Puts one variable back exactly as it was.
 *
 * Assigning `undefined` to `process.env` stores the string `"undefined"`, which
 * would leave a numeric variable parsing as `NaN` and fail every later test in
 * the file rather than the one that changed it.
 */
function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  resetStorageConfiguration();
  closeStorageClient();
}

function fakeInspector(
  verdict: StorageInspectionVerdict | (() => Promise<StorageInspectionVerdict>),
): StorageContentInspector {
  return {
    inspect: async () =>
      typeof verdict === "function" ? verdict() : Promise.resolve(verdict),
  };
}

type Uploaded = Readonly<{
  intentId: string;
  objectId: string;
  finalizeToken: string;
  bytes: Uint8Array;
}>;

/** Creates an intent and posts matching bytes to the presigned form. */
async function stageUpload(
  size = 96,
  policy = pdfPolicy,
): Promise<Uploaded & { stagingKey: string }> {
  const bytes = testBytes(size);
  const intent = await createUploadIntent({
    policy,
    file: {
      contentType: "application/pdf",
      extension: "pdf",
      sizeBytes: bytes.byteLength,
      checksumSha256: sha256Hex(bytes),
    },
  });

  const response = await postPresignedUpload(intent.upload, bytes);

  expect(response.status).toBeLessThan(400);

  const row = await database.storageUploadIntent.findUniqueOrThrow({
    where: { id: intent.intentId },
    select: { stagingKey: true },
  });

  return {
    intentId: intent.intentId,
    objectId: intent.objectId,
    finalizeToken: intent.finalizeToken,
    bytes,
    stagingKey: row.stagingKey,
  };
}

async function readFinalKey(objectId: string): Promise<string> {
  const row = await database.storageObject.findUniqueOrThrow({
    where: { id: objectId },
    select: { objectKey: true },
  });

  return row.objectKey;
}

beforeAll(async () => {
  await ensureTestBucket(testClient, target.bucket);
  await deleteKeysUnderPrefix(testClient, target.bucket, runPrefix);

  await testClient.send(
    new PutObjectCommand({
      Bucket: target.bucket,
      Key: foreignKey,
      Body: Buffer.from("not this run"),
    }),
  );
});

afterAll(async () => {
  // The run's own rows go first, by identifier, so a failed test cannot leave a
  // row that a later run's cleanup pass would pick up.
  await database.storageUploadIntent.deleteMany({
    where: { stagingKey: { startsWith: runPrefix } },
  });
  await database.storageObject.deleteMany({
    where: { objectKey: { startsWith: runPrefix } },
  });

  await deleteKeysUnderPrefix(testClient, target.bucket, runPrefix);

  const remaining = await listKeysUnderPrefix(
    testClient,
    target.bucket,
    runPrefix,
  );

  if (remaining.length > 0) {
    throw new Error(
      `The suite left ${remaining.length} objects under its own prefix.`,
    );
  }

  const foreign = await listKeysUnderPrefix(
    testClient,
    target.bucket,
    foreignKey,
  );

  if (foreign.length !== 1) {
    throw new Error("The suite disturbed an object belonging to another run.");
  }

  await deleteKeysUnderPrefix(testClient, target.bucket, foreignKey);

  closeStorageClient();
  testClient.destroy();
  await database.$disconnect();
});

describe("the bucket", () => {
  it("reports healthy", async () => {
    await expect(checkStorageHealth()).resolves.toEqual({
      status: STORAGE_HEALTH_STATUS.HEALTHY,
      latencyMs: expect.any(Number),
    });
  });

  it("grants no anonymous access", async () => {
    await expect(
      bucketAllowsAnonymousAccess(testClient, target.bucket),
    ).resolves.toBe(false);
  });

  it("reports misconfigured for a bucket that does not exist", async () => {
    resetStorageConfiguration();
    closeStorageClient();

    const original = process.env.STORAGE_BUCKET;

    process.env.STORAGE_BUCKET = "nfs-bucket-that-does-not-exist";

    try {
      await expect(checkStorageHealth()).resolves.toEqual({
        status: STORAGE_HEALTH_STATUS.MISCONFIGURED,
      });
    } finally {
      restoreEnvironment("STORAGE_BUCKET", original);
    }
  });

  it("reports misconfigured for a credential the provider refuses", async () => {
    resetStorageConfiguration();
    closeStorageClient();

    const original = process.env.STORAGE_SECRET_ACCESS_KEY;

    process.env.STORAGE_SECRET_ACCESS_KEY = "an-incorrect-secret-access-key";

    try {
      await expect(checkStorageHealth()).resolves.toEqual({
        status: STORAGE_HEALTH_STATUS.MISCONFIGURED,
      });
    } finally {
      restoreEnvironment("STORAGE_SECRET_ACCESS_KEY", original);
    }
  });

  it("reports unavailable, within its own timeout, for an endpoint that never answers", async () => {
    resetStorageConfiguration();
    closeStorageClient();

    const originalEndpoint = process.env.STORAGE_ENDPOINT;
    const originalConnect = process.env.STORAGE_CONNECT_TIMEOUT_MS;

    // A port with nothing listening on it. The point of the assertion is the
    // elapsed time as much as the status: an unbounded client would hang here
    // and take a readiness probe with it.
    process.env.STORAGE_ENDPOINT = "http://127.0.0.1:9199";
    process.env.STORAGE_CONNECT_TIMEOUT_MS = "500";

    const startedAt = Date.now();

    try {
      await expect(checkStorageHealth()).resolves.toEqual({
        status: STORAGE_HEALTH_STATUS.UNAVAILABLE,
      });

      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      restoreEnvironment("STORAGE_ENDPOINT", originalEndpoint);
      restoreEnvironment("STORAGE_CONNECT_TIMEOUT_MS", originalConnect);
    }
  });
});

describe("the presigned upload", () => {
  it("accepts the bytes it was signed for", async () => {
    const uploaded = await stageUpload();

    await expect(
      listKeysUnderPrefix(testClient, target.bucket, uploaded.stagingKey),
    ).resolves.toEqual([uploaded.stagingKey]);
  });

  it("refuses a body larger than the declared size", async () => {
    const declared = testBytes(64);
    const oversized = testBytes(4096);

    const intent = await createUploadIntent({
      policy: pdfPolicy,
      file: {
        contentType: "application/pdf",
        extension: "pdf",
        sizeBytes: declared.byteLength,
        checksumSha256: sha256Hex(declared),
      },
    });

    const response = await postPresignedUpload(intent.upload, oversized);

    // The provider refused it, so no object was ever created — the size limit
    // is enforced before the bytes are stored rather than cleaned up after.
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a key the client changed", async () => {
    const bytes = testBytes(64);
    const intent = await createUploadIntent({
      policy: pdfPolicy,
      file: {
        contentType: "application/pdf",
        extension: "pdf",
        sizeBytes: bytes.byteLength,
        checksumSha256: sha256Hex(bytes),
      },
    });

    const response = await postPresignedUpload(intent.upload, bytes, {
      key: `${runPrefix}staging/a-key-the-client-chose`,
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a media type the client changed", async () => {
    const bytes = testBytes(64);
    const intent = await createUploadIntent({
      policy: pdfPolicy,
      file: {
        contentType: "application/pdf",
        extension: "pdf",
        sizeBytes: bytes.byteLength,
        checksumSha256: sha256Hex(bytes),
      },
    });

    const response = await postPresignedUpload(intent.upload, bytes, {
      "Content-Type": "text/html",
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("hands the client a staging key and never the final key", async () => {
    const bytes = testBytes(64);
    const intent = await createUploadIntent({
      policy: pdfPolicy,
      file: {
        contentType: "application/pdf",
        extension: "pdf",
        sizeBytes: bytes.byteLength,
        checksumSha256: sha256Hex(bytes),
      },
    });

    const finalKey = await readFinalKey(intent.objectId);
    const serialized = JSON.stringify(intent);

    expect(serialized).not.toContain(finalKey);
    expect(serialized).not.toContain(target.secretAccessKey);
    expect(finalKey).toContain("/objects/");
    expect(intent.upload.fields.key).toContain("/staging/");
    expect(intent.upload.fields.key).not.toBe(finalKey);

    // The staging key is random and 48 hexadecimal characters long, so knowing
    // it says nothing about the final key: the two are generated independently
    // and neither is derivable from the other.
    const stagingRandom = intent.upload.fields.key?.split("/").at(-1) ?? "";
    const finalRandom = finalKey.split("/").at(-1) ?? "";

    expect(stagingRandom).toMatch(/^[0-9a-f]{48}$/);
    expect(finalRandom).toMatch(/^[0-9a-f]{48}$/);
    expect(stagingRandom).not.toBe(finalRandom);
  });
});

describe("finalization", () => {
  it("promotes a verified upload and serves the exact bytes back", async () => {
    const uploaded = await stageUpload(512);

    const finalized = await finalizeUploadIntent({
      intentId: uploaded.intentId,
      finalizeToken: uploaded.finalizeToken,
      policy: pdfPolicy,
    });

    expect(finalized.object).toEqual({
      id: uploaded.objectId,
      status: "ready",
      contentType: "application/pdf",
      sizeBytes: 512,
      checksumSha256: sha256Hex(uploaded.bytes),
      readyAt: expect.any(String),
      inspection: STORAGE_INSPECTION_RESULT.NOT_CONFIGURED,
    });

    const link = await createStorageDownloadUrl({
      objectId: uploaded.objectId,
    });
    const response = await fetch(link.url);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      uploaded.bytes,
    );
  });

  it("removes the staged copy once the object is ready", async () => {
    const uploaded = await stageUpload();

    await finalizeUploadIntent({
      intentId: uploaded.intentId,
      finalizeToken: uploaded.finalizeToken,
      policy: pdfPolicy,
    });

    await expect(
      listKeysUnderPrefix(testClient, target.bucket, uploaded.stagingKey),
    ).resolves.toEqual([]);
  });

  it("answers a replay with the same object", async () => {
    const uploaded = await stageUpload();

    const first = await finalizeUploadIntent({
      intentId: uploaded.intentId,
      finalizeToken: uploaded.finalizeToken,
      policy: pdfPolicy,
    });
    const second = await finalizeUploadIntent({
      intentId: uploaded.intentId,
      finalizeToken: uploaded.finalizeToken,
      policy: pdfPolicy,
    });

    expect(second).toEqual(first);
  });

  it("produces one final object when two attempts race", async () => {
    const uploaded = await stageUpload();

    const results = await Promise.allSettled([
      finalizeUploadIntent({
        intentId: uploaded.intentId,
        finalizeToken: uploaded.finalizeToken,
        policy: pdfPolicy,
      }),
      finalizeUploadIntent({
        intentId: uploaded.intentId,
        finalizeToken: uploaded.finalizeToken,
        policy: pdfPolicy,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");

    // One winner. The loser is refused with a conflict rather than producing a
    // second promotion, and PostgreSQL is the only thing coordinating them.
    expect(fulfilled).toHaveLength(1);

    const finalKey = await readFinalKey(uploaded.objectId);

    await expect(
      listKeysUnderPrefix(testClient, target.bucket, finalKey),
    ).resolves.toEqual([finalKey]);
  });

  it("refuses a token that is not the one it issued", async () => {
    const uploaded = await stageUpload();

    await expect(
      finalizeUploadIntent({
        intentId: uploaded.intentId,
        finalizeToken: "z".repeat(43),
        policy: pdfPolicy,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers an unknown intent exactly as it answers a wrong token", async () => {
    const uploaded = await stageUpload();

    const wrongToken = (await finalizeUploadIntent({
      intentId: uploaded.intentId,
      finalizeToken: "z".repeat(43),
      policy: pdfPolicy,
    }).catch((error: unknown) => error)) as Error;

    const unknownIntent = (await finalizeUploadIntent({
      intentId: "01998aaa-0000-7000-8000-000000000000",
      finalizeToken: uploaded.finalizeToken,
      policy: pdfPolicy,
    }).catch((error: unknown) => error)) as Error;

    expect(wrongToken.constructor.name).toBe(unknownIntent.constructor.name);
    expect(wrongToken.message).toBe(unknownIntent.message);
  });

  it("refuses an intent that has expired", async () => {
    const uploaded = await stageUpload();

    await expect(
      finalizeUploadIntent({
        intentId: uploaded.intentId,
        finalizeToken: uploaded.finalizeToken,
        policy: pdfPolicy,
        now: new Date(Date.now() + 48 * 60 * 60 * 1_000),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a policy other than the one that authorized the upload", async () => {
    const uploaded = await stageUpload();

    await expect(
      finalizeUploadIntent({
        intentId: uploaded.intentId,
        finalizeToken: uploaded.finalizeToken,
        policy: scannedPolicy,
        inspector: fakeInspector({ outcome: INSPECTION_OUTCOME.CLEAN }),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects an upload that never arrived", async () => {
    const bytes = testBytes(64);
    const intent = await createUploadIntent({
      policy: pdfPolicy,
      file: {
        contentType: "application/pdf",
        extension: "pdf",
        sizeBytes: bytes.byteLength,
        checksumSha256: sha256Hex(bytes),
      },
    });

    await expect(
      finalizeUploadIntent({
        intentId: intent.intentId,
        finalizeToken: intent.finalizeToken,
        policy: pdfPolicy,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(getStorageObjectMetadata(intent.objectId)).resolves.toBeNull();
  });
});

describe("verification against what actually arrived", () => {
  /**
   * Writes bytes straight to the staging key with the test client.
   *
   * This deliberately bypasses the presigned form, because the form's own
   * conditions already refuse a wrong size and a wrong media type — which is
   * the right place for them and also means the finalization checks would never
   * run in a test that went through it. Writing directly models the provider
   * that did not enforce, which is exactly the case the second layer exists for.
   */
  async function stageDirectly(
    stagingKey: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await testClient.send(
      new PutObjectCommand({
        Bucket: target.bucket,
        Key: stagingKey,
        Body: Buffer.from(body),
        ContentType: contentType,
      }),
    );
  }

  async function intentWithDeclaredBytes(declared: Uint8Array) {
    const intent = await createUploadIntent({
      policy: pdfPolicy,
      file: {
        contentType: "application/pdf",
        extension: "pdf",
        sizeBytes: declared.byteLength,
        checksumSha256: sha256Hex(declared),
      },
    });

    const row = await database.storageUploadIntent.findUniqueOrThrow({
      where: { id: intent.intentId },
      select: { stagingKey: true },
    });

    return { ...intent, stagingKey: row.stagingKey };
  }

  it("rejects bytes of the wrong size", async () => {
    const declared = testBytes(128);
    const intent = await intentWithDeclaredBytes(declared);

    await stageDirectly(intent.stagingKey, testBytes(64), "application/pdf");

    await expect(
      finalizeUploadIntent({
        intentId: intent.intentId,
        finalizeToken: intent.finalizeToken,
        policy: pdfPolicy,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const row = await database.storageUploadIntent.findUniqueOrThrow({
      where: { id: intent.intentId },
      select: { status: true, failureReason: true },
    });

    expect(row.status).toBe("REJECTED");
    expect(row.failureReason).toBe("size-mismatch");
  });

  it("rejects bytes whose checksum does not match the declaration", async () => {
    const declared = testBytes(128);
    const other = testBytes(128);
    const intent = await intentWithDeclaredBytes(declared);

    // The same length, so only the streamed SHA-256 can tell them apart. This
    // is the path a provider that stores no checksum of its own puts the
    // platform on, and MinIO does not store one for a plain `PutObject`.
    await stageDirectly(intent.stagingKey, other, "application/pdf");

    await expect(
      finalizeUploadIntent({
        intentId: intent.intentId,
        finalizeToken: intent.finalizeToken,
        policy: pdfPolicy,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const row = await database.storageUploadIntent.findUniqueOrThrow({
      where: { id: intent.intentId },
      select: { failureReason: true },
    });

    expect(row.failureReason).toBe("checksum-mismatch");
  });

  it("rejects bytes stored under a different media type", async () => {
    const declared = testBytes(128);
    const intent = await intentWithDeclaredBytes(declared);

    await stageDirectly(intent.stagingKey, declared, "text/html");

    await expect(
      finalizeUploadIntent({
        intentId: intent.intentId,
        finalizeToken: intent.finalizeToken,
        policy: pdfPolicy,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const row = await database.storageUploadIntent.findUniqueOrThrow({
      where: { id: intent.intentId },
      select: { failureReason: true },
    });

    expect(row.failureReason).toBe("content-type-mismatch");
  });

  it("issues no download for an object it rejected", async () => {
    const declared = testBytes(128);
    const intent = await intentWithDeclaredBytes(declared);

    await stageDirectly(intent.stagingKey, testBytes(64), "application/pdf");

    await finalizeUploadIntent({
      intentId: intent.intentId,
      finalizeToken: intent.finalizeToken,
      policy: pdfPolicy,
    }).catch(() => undefined);

    await expect(
      createStorageDownloadUrl({ objectId: intent.objectId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the final object is immutable", () => {
  it("keeps its bytes when the staging upload is replayed", async () => {
    const uploaded = await stageUpload(256);

    await finalizeUploadIntent({
      intentId: uploaded.intentId,
      finalizeToken: uploaded.finalizeToken,
      policy: pdfPolicy,
    });

    // The client still holds a form it could post again, and it is used here
    // with different bytes — which is precisely the attack the staging-to-final
    // promotion exists to defeat. Even a successful write to staging cannot
    // reach the object a module reads, because the object lives at a key the
    // client was never given and no presigned upload was ever issued for.
    const different = testBytes(256);

    await testClient.send(
      new PutObjectCommand({
        Bucket: target.bucket,
        Key: uploaded.stagingKey,
        Body: Buffer.from(different),
        ContentType: "application/pdf",
      }),
    );

    const link = await createStorageDownloadUrl({
      objectId: uploaded.objectId,
    });
    const response = await fetch(link.url);
    const served = new Uint8Array(await response.arrayBuffer());

    expect(served).toEqual(uploaded.bytes);
    expect(served).not.toEqual(different);

    await deleteKeysUnderPrefix(testClient, target.bucket, uploaded.stagingKey);
  });

  it("refuses the promotion when the staged bytes change under it", async () => {
    const uploaded = await stageUpload(256);
    const swapped = testBytes(256);

    // The inspector runs after the staged object has been read and verified and
    // before it is copied, which makes it the one deterministic place to open
    // the window this test is about. The conditional copy's entity-tag
    // precondition is what has to notice.
    const swappingInspector = fakeInspector(async () => {
      await testClient.send(
        new PutObjectCommand({
          Bucket: target.bucket,
          Key: uploaded.stagingKey,
          Body: Buffer.from(swapped),
          ContentType: "application/pdf",
        }),
      );

      return { outcome: INSPECTION_OUTCOME.CLEAN };
    });

    await expect(
      finalizeUploadIntent({
        intentId: uploaded.intentId,
        finalizeToken: uploaded.finalizeToken,
        policy: pdfPolicy,
        inspector: swappingInspector,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      getStorageObjectMetadata(uploaded.objectId),
    ).resolves.toBeNull();

    const finalKey = await readFinalKey(uploaded.objectId);

    await expect(
      listKeysUnderPrefix(testClient, target.bucket, finalKey),
    ).resolves.toEqual([]);
  });
});

describe("content inspection", () => {
  it("records not-configured when a policy allows inspection and none is supplied", async () => {
    const uploaded = await stageUpload();

    const finalized = await finalizeUploadIntent({
      intentId: uploaded.intentId,
      finalizeToken: uploaded.finalizeToken,
      policy: pdfPolicy,
    });

    // The object is usable, and the record does not claim anybody looked at it.
    expect(finalized.object.inspection).toBe(
      STORAGE_INSPECTION_RESULT.NOT_CONFIGURED,
    );
  });

  it("fails closed when a policy requires inspection and none is supplied", async () => {
    const uploaded = await stageUpload(96, scannedPolicy);

    await expect(
      finalizeUploadIntent({
        intentId: uploaded.intentId,
        finalizeToken: uploaded.finalizeToken,
        policy: scannedPolicy,
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });

    await expect(
      getStorageObjectMetadata(uploaded.objectId),
    ).resolves.toBeNull();
  });

  it("promotes an object an inspector called clean", async () => {
    const uploaded = await stageUpload(96, scannedPolicy);

    const finalized = await finalizeUploadIntent({
      intentId: uploaded.intentId,
      finalizeToken: uploaded.finalizeToken,
      policy: scannedPolicy,
      inspector: fakeInspector({ outcome: INSPECTION_OUTCOME.CLEAN }),
    });

    expect(finalized.object.inspection).toBe(STORAGE_INSPECTION_RESULT.CLEAN);
  });

  it("withholds an object an inspector quarantined, and keeps the evidence", async () => {
    const uploaded = await stageUpload(96, scannedPolicy);

    await expect(
      finalizeUploadIntent({
        intentId: uploaded.intentId,
        finalizeToken: uploaded.finalizeToken,
        policy: scannedPolicy,
        inspector: fakeInspector({
          outcome: INSPECTION_OUTCOME.QUARANTINE,
          reasonCode: "signature-match",
        }),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const row = await database.storageObject.findUniqueOrThrow({
      where: { id: uploaded.objectId },
      select: {
        status: true,
        objectKey: true,
        inspectionResult: true,
        inspectionReason: true,
      },
    });

    expect(row.status).toBe("QUARANTINED");
    expect(row.inspectionResult).toBe("QUARANTINED");
    expect(row.inspectionReason).toBe("signature-match");
    expect(row.objectKey).toContain("/quarantine/");

    // The bytes are still there, out of the way, under a key nothing will sign.
    await expect(
      listKeysUnderPrefix(testClient, target.bucket, row.objectKey),
    ).resolves.toEqual([row.objectKey]);

    await expect(
      createStorageDownloadUrl({ objectId: uploaded.objectId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not expose what an inspector threw", async () => {
    const uploaded = await stageUpload(96, scannedPolicy);

    const failing: StorageContentInspector = {
      inspect: () =>
        Promise.reject(
          new Error(
            "scanner said: /var/lib/clamav socket refused for token abc",
          ),
        ),
    };

    const error = (await finalizeUploadIntent({
      intentId: uploaded.intentId,
      finalizeToken: uploaded.finalizeToken,
      policy: scannedPolicy,
      inspector: failing,
    }).catch((thrown: unknown) => thrown)) as Error;

    expect(error).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(error.message).not.toContain("clamav");
    expect(error.message).not.toContain("abc");

    // The attempt was released rather than terminated, so the client may retry
    // once the scanner is back.
    const row = await database.storageUploadIntent.findUniqueOrThrow({
      where: { id: uploaded.intentId },
      select: { status: true },
    });

    expect(row.status).toBe("PENDING");
  });
});

describe("downloads", () => {
  it("carries a caller-chosen filename, including a non-ASCII one", async () => {
    const uploaded = await stageUpload();

    await finalizeUploadIntent({
      intentId: uploaded.intentId,
      finalizeToken: uploaded.finalizeToken,
      policy: pdfPolicy,
    });

    const link = await createStorageDownloadUrl({
      objectId: uploaded.objectId,
      filename: "تقرير سنوي.pdf",
    });
    const response = await fetch(link.url);
    const disposition = response.headers.get("content-disposition") ?? "";

    expect(response.status).toBe(200);
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).not.toContain("\n");
  });

  it("stops working once the signature has expired", async () => {
    const uploaded = await stageUpload();

    await finalizeUploadIntent({
      intentId: uploaded.intentId,
      finalizeToken: uploaded.finalizeToken,
      policy: pdfPolicy,
    });

    const link = await createStorageDownloadUrl({
      objectId: uploaded.objectId,
      ttlSeconds: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 2_500));

    const response = await fetch(link.url);

    expect(response.status).toBe(403);
  });

  it("refuses an object that is still pending", async () => {
    const uploaded = await stageUpload();

    await expect(
      createStorageDownloadUrl({ objectId: uploaded.objectId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("cleanup", () => {
  /** Ages an intent so a cleanup pass will consider it. */
  async function expire(
    intentId: string,
    status: "PENDING" | "FINALIZING",
  ): Promise<void> {
    const row = await database.storageUploadIntent.findUniqueOrThrow({
      where: { id: intentId },
      select: { createdAt: true },
    });

    await database.storageUploadIntent.update({
      where: { id: intentId },
      data: {
        status,
        // One millisecond after creation, which satisfies the database's
        // "expires after it was created" constraint and is comfortably in the
        // past.
        expiresAt: new Date(row.createdAt.getTime() + 1),
        ...(status === "FINALIZING"
          ? {
              finalizeLeaseTokenHash: "0".repeat(64),
              finalizeLeaseExpiresAt: new Date(row.createdAt.getTime() + 1),
            }
          : {}),
      },
    });
  }

  it("removes the staged bytes of an intent nobody finished", async () => {
    const uploaded = await stageUpload();

    await expire(uploaded.intentId, "PENDING");

    const result = await cleanupExpiredUploadIntents({ limit: 50 });

    expect(result.expiredIntents).toBeGreaterThanOrEqual(1);

    await expect(
      listKeysUnderPrefix(testClient, target.bucket, uploaded.stagingKey),
    ).resolves.toEqual([]);

    const row = await database.storageUploadIntent.findUniqueOrThrow({
      where: { id: uploaded.intentId },
      select: { status: true },
    });

    expect(row.status).toBe("EXPIRED");
  });

  it("removes the orphan a crashed finalization left at the final key", async () => {
    const uploaded = await stageUpload();
    const finalKey = await readFinalKey(uploaded.objectId);

    // Exactly the state §18 describes: the copy succeeded and the process died
    // before it could commit, so a final object exists that no ready row points
    // at.
    await testClient.send(
      new PutObjectCommand({
        Bucket: target.bucket,
        Key: finalKey,
        Body: Buffer.from(uploaded.bytes),
        ContentType: "application/pdf",
      }),
    );

    await expire(uploaded.intentId, "FINALIZING");

    await cleanupExpiredUploadIntents({ limit: 50 });

    await expect(
      listKeysUnderPrefix(testClient, target.bucket, finalKey),
    ).resolves.toEqual([]);
    await expect(
      listKeysUnderPrefix(testClient, target.bucket, uploaded.stagingKey),
    ).resolves.toEqual([]);
  });

  it("never touches an object that became ready", async () => {
    const uploaded = await stageUpload();

    await finalizeUploadIntent({
      intentId: uploaded.intentId,
      finalizeToken: uploaded.finalizeToken,
      policy: pdfPolicy,
    });

    const finalKey = await readFinalKey(uploaded.objectId);

    await cleanupExpiredUploadIntents({ limit: 50 });

    await expect(
      listKeysUnderPrefix(testClient, target.bucket, finalKey),
    ).resolves.toEqual([finalKey]);
    await expect(
      getStorageObjectMetadata(uploaded.objectId),
    ).resolves.not.toBeNull();
  });

  it("never touches an object an inspector quarantined", async () => {
    const uploaded = await stageUpload(96, scannedPolicy);

    await finalizeUploadIntent({
      intentId: uploaded.intentId,
      finalizeToken: uploaded.finalizeToken,
      policy: scannedPolicy,
      inspector: fakeInspector({
        outcome: INSPECTION_OUTCOME.QUARANTINE,
        reasonCode: "signature-match",
      }),
    }).catch(() => undefined);

    const quarantineKey = await readFinalKey(uploaded.objectId);

    await cleanupExpiredUploadIntents({ limit: 50 });

    await expect(
      listKeysUnderPrefix(testClient, target.bucket, quarantineKey),
    ).resolves.toEqual([quarantineKey]);
  });

  it("leaves another run's objects alone", async () => {
    await cleanupExpiredUploadIntents({ limit: 50 });

    await expect(
      listKeysUnderPrefix(testClient, target.bucket, foreignKey),
    ).resolves.toEqual([foreignKey]);
  });

  it("refuses a batch larger than its ceiling", async () => {
    await expect(
      cleanupExpiredUploadIntents({ limit: 10_000 }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("stops at the batch size it was given", async () => {
    const staged = await Promise.all([
      stageUpload(),
      stageUpload(),
      stageUpload(),
    ]);

    for (const uploaded of staged) {
      await expire(uploaded.intentId, "PENDING");
    }

    const result = await cleanupExpiredUploadIntents({ limit: 2 });

    expect(result.examined).toBeLessThanOrEqual(2);
  });
});
