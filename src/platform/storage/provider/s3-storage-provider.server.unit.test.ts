import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
const destroy = vi.hoisted(() => vi.fn());
const createPresignedPost = vi.hoisted(() => vi.fn());
const getSignedUrl = vi.hoisted(() => vi.fn());
const commands = vi.hoisted(
  () => [] as Array<{ name: string; input: unknown }>,
);

function command(name: string) {
  return class {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
      commands.push({ name, input });
    }
  };
}

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = send;
    destroy = destroy;
  },
  CopyObjectCommand: command("CopyObject"),
  DeleteObjectCommand: command("DeleteObject"),
  GetObjectCommand: command("GetObject"),
  HeadBucketCommand: command("HeadBucket"),
  HeadObjectCommand: command("HeadObject"),
}));

vi.mock("@aws-sdk/s3-presigned-post", () => ({ createPresignedPost }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl }));

const { createS3StorageProvider } =
  await import("./s3-storage-provider.server");
const { STORAGE_PROVIDER_FAILURE, StorageProviderError } =
  await import("./storage-provider");

const configuration = {
  enabled: true as const,
  region: "us-east-1",
  bucket: "application-uploads",
  endpoint: "http://127.0.0.1:9000",
  forcePathStyle: true,
  credentials: { accessKeyId: "an-id", secretAccessKey: "a-secret" },
  keyPrefix: "next-fullstack-starter",
  connectTimeoutMs: 1_000,
  requestTimeoutMs: 2_000,
  uploadUrlTtlSeconds: 900,
  downloadUrlTtlSeconds: 300,
  uploadIntentTtlSeconds: 900,
  finalizeLeaseMs: 30_000,
  maxUploadBytes: 26_214_400,
};

const KEY = "next-fullstack-starter/test/run-1/staging/abcdef0123456789";
const FINAL_KEY = "next-fullstack-starter/test/run-1/objects/abcdef0123456789";
const CHECKSUM = "a".repeat(64);

function provider() {
  return createS3StorageProvider(configuration);
}

function awsError(name: string, httpStatusCode?: number) {
  return Object.assign(new Error("A message that must never be surfaced."), {
    name,
    $metadata: { httpStatusCode },
  });
}

function lastCommand(name: string) {
  return commands.filter((entry) => entry.name === name).at(-1)
    ?.input as Record<string, unknown>;
}

beforeEach(() => {
  send.mockReset();
  destroy.mockReset();
  createPresignedPost.mockReset();
  getSignedUrl.mockReset();
  commands.length = 0;
});

describe("the presigned upload", () => {
  it("signs a policy that pins the key, the media type, and the exact size", async () => {
    createPresignedPost.mockResolvedValue({
      url: "http://127.0.0.1:9000/application-uploads",
      fields: { key: KEY },
    });

    const upload = await provider().createPresignedUpload({
      key: KEY,
      contentType: "application/pdf",
      sizeBytes: 1024,
      checksumSha256: CHECKSUM,
      expiresInSeconds: 600,
    });

    expect(upload.method).toBe("POST");

    const request = createPresignedPost.mock.calls[0]?.[1] as {
      Conditions: unknown[];
      Fields: Record<string, string>;
      Expires: number;
    };

    // Exact rather than generous: one key, one media type, and the declared
    // size as both ends of the range, so the form authorizes precisely the
    // upload that was asked for.
    expect(request.Conditions).toContainEqual(["eq", "$key", KEY]);
    expect(request.Conditions).toContainEqual([
      "eq",
      "$Content-Type",
      "application/pdf",
    ]);
    expect(request.Conditions).toContainEqual([
      "content-length-range",
      1024,
      1024,
    ]);
    expect(request.Expires).toBe(600);
  });

  it("never signs an ACL", async () => {
    createPresignedPost.mockResolvedValue({ url: "http://x", fields: {} });

    await provider().createPresignedUpload({
      key: KEY,
      contentType: "application/pdf",
      sizeBytes: 1024,
      checksumSha256: CHECKSUM,
      expiresInSeconds: 600,
    });

    const serialized = JSON.stringify(createPresignedPost.mock.calls[0]?.[1]);

    expect(serialized).not.toContain("acl");
    expect(serialized).not.toContain("ACL");
    expect(serialized).not.toContain("public-read");
  });

  it("refuses a key that is not well-formed before it signs anything", async () => {
    await expect(
      provider().createPresignedUpload({
        key: "../../etc/passwd",
        contentType: "application/pdf",
        sizeBytes: 1024,
        checksumSha256: CHECKSUM,
        expiresInSeconds: 600,
      }),
    ).rejects.toThrow();

    expect(createPresignedPost).not.toHaveBeenCalled();
  });

  it("hands the fields out frozen", async () => {
    createPresignedPost.mockResolvedValue({
      url: "http://x",
      fields: { key: KEY },
    });

    const upload = await provider().createPresignedUpload({
      key: KEY,
      contentType: "application/pdf",
      sizeBytes: 1024,
      checksumSha256: CHECKSUM,
      expiresInSeconds: 600,
    });

    expect(Object.isFrozen(upload.fields)).toBe(true);
  });
});

describe("reading object metadata", () => {
  it("asks the provider for its own checksum", async () => {
    send.mockResolvedValue({
      ContentLength: 1024,
      ContentType: "application/pdf",
      ETag: '"an-entity-tag"',
      ChecksumSHA256: Buffer.from(CHECKSUM, "hex").toString("base64"),
    });

    await expect(provider().headObject(KEY)).resolves.toEqual({
      sizeBytes: 1024,
      contentType: "application/pdf",
      etag: "an-entity-tag",
      checksumSha256: CHECKSUM,
    });

    expect(lastCommand("HeadObject")).toMatchObject({
      ChecksumMode: "ENABLED",
    });
  });

  it("answers a null checksum when the provider stored none", async () => {
    send.mockResolvedValue({
      ContentLength: 1024,
      ETag: '"tag"',
    });

    await expect(provider().headObject(KEY)).resolves.toMatchObject({
      checksumSha256: null,
      contentType: null,
    });
  });

  it("answers a null checksum when the provider used another algorithm", async () => {
    send.mockResolvedValue({
      ContentLength: 1024,
      ETag: '"tag"',
      ChecksumSHA256: "not-a-sha-256",
    });

    await expect(provider().headObject(KEY)).resolves.toMatchObject({
      checksumSha256: null,
    });
  });

  it("treats a response with no length as unavailable", async () => {
    send.mockResolvedValue({ ETag: '"tag"' });

    await expect(provider().headObject(KEY)).rejects.toMatchObject({
      failure: STORAGE_PROVIDER_FAILURE.UNAVAILABLE,
    });
  });
});

describe("streaming an object to compute its checksum", () => {
  it("hashes what it read", async () => {
    send.mockResolvedValue({
      Body: Readable.from([Buffer.from("hello "), Buffer.from("world")]),
    });

    const expected = Buffer.from(
      await import("node:crypto").then((crypto) =>
        crypto.createHash("sha256").update("hello world").digest("hex"),
      ),
    ).toString();

    await expect(
      provider().computeObjectChecksum({ key: KEY, maxBytes: 1024 }),
    ).resolves.toBe(expected);
  });

  it("stops as soon as the object exceeds the declared size", async () => {
    // A `Content-Length` is a claim like any other. The ceiling is checked
    // before each chunk is hashed, so an object larger than the declaration
    // costs one chunk of memory rather than its whole size.
    const body = Readable.from([Buffer.alloc(8), Buffer.alloc(8)]);
    const destroySpy = vi.spyOn(body, "destroy");

    send.mockResolvedValue({ Body: body });

    await expect(
      provider().computeObjectChecksum({ key: KEY, maxBytes: 10 }),
    ).rejects.toMatchObject({
      failure: STORAGE_PROVIDER_FAILURE.PRECONDITION_FAILED,
    });

    expect(destroySpy).toHaveBeenCalled();
  });

  it("closes the stream even when the read succeeds", async () => {
    const body = Readable.from([Buffer.from("x")]);
    const destroySpy = vi.spyOn(body, "destroy");

    send.mockResolvedValue({ Body: body });

    await provider().computeObjectChecksum({ key: KEY, maxBytes: 10 });

    expect(destroySpy).toHaveBeenCalled();
  });

  it("treats a response with no body as a missing object", async () => {
    send.mockResolvedValue({});

    await expect(
      provider().computeObjectChecksum({ key: KEY, maxBytes: 10 }),
    ).rejects.toMatchObject({ failure: STORAGE_PROVIDER_FAILURE.NOT_FOUND });
  });
});

describe("the conditional copy", () => {
  it("carries the source entity tag as a precondition", async () => {
    send.mockResolvedValue({ CopyObjectResult: { ETag: '"final-tag"' } });

    await expect(
      provider().copyObjectConditionally({
        sourceKey: KEY,
        destinationKey: FINAL_KEY,
        contentType: "application/pdf",
        sourceEtag: "source-tag",
      }),
    ).resolves.toBe("final-tag");

    expect(lastCommand("CopyObject")).toMatchObject({
      CopySource: `application-uploads/${KEY}`,
      CopySourceIfMatch: '"source-tag"',
      MetadataDirective: "REPLACE",
    });
  });

  it("sends no ACL with the copy", async () => {
    send.mockResolvedValue({ CopyObjectResult: { ETag: '"tag"' } });

    await provider().copyObjectConditionally({
      sourceKey: KEY,
      destinationKey: FINAL_KEY,
      contentType: "application/pdf",
      sourceEtag: "source-tag",
    });

    expect(JSON.stringify(lastCommand("CopyObject"))).not.toContain("ACL");
  });

  it("reports a precondition failure as its own code", async () => {
    send.mockRejectedValue(awsError("PreconditionFailed", 412));

    await expect(
      provider().copyObjectConditionally({
        sourceKey: KEY,
        destinationKey: FINAL_KEY,
        contentType: "application/pdf",
        sourceEtag: "source-tag",
      }),
    ).rejects.toMatchObject({
      failure: STORAGE_PROVIDER_FAILURE.PRECONDITION_FAILED,
    });
  });

  it("treats a copy with no resulting tag as unavailable", async () => {
    send.mockResolvedValue({});

    await expect(
      provider().copyObjectConditionally({
        sourceKey: KEY,
        destinationKey: FINAL_KEY,
        contentType: "application/pdf",
        sourceEtag: "source-tag",
      }),
    ).rejects.toMatchObject({ failure: STORAGE_PROVIDER_FAILURE.UNAVAILABLE });
  });
});

describe("the presigned download", () => {
  it("signs a bounded GET carrying the response headers it was given", async () => {
    getSignedUrl.mockResolvedValue("https://signed.example/object");

    await expect(
      provider().createPresignedDownload({
        key: FINAL_KEY,
        expiresInSeconds: 120,
        contentType: "application/pdf",
        contentDisposition: 'attachment; filename="a.pdf"',
      }),
    ).resolves.toBe("https://signed.example/object");

    expect(lastCommand("GetObject")).toMatchObject({
      ResponseContentType: "application/pdf",
      ResponseContentDisposition: 'attachment; filename="a.pdf"',
    });
    expect(getSignedUrl.mock.calls[0]?.[2]).toEqual({ expiresIn: 120 });
  });

  it("omits the response headers it was not given", async () => {
    getSignedUrl.mockResolvedValue("https://signed.example/object");

    await provider().createPresignedDownload({
      key: FINAL_KEY,
      expiresInSeconds: 120,
    });

    expect(lastCommand("GetObject")).not.toHaveProperty("ResponseContentType");
    expect(lastCommand("GetObject")).not.toHaveProperty(
      "ResponseContentDisposition",
    );
  });
});

describe("deleting and checking the bucket", () => {
  it("deletes one key", async () => {
    send.mockResolvedValue({});

    await provider().deleteObject(KEY);

    expect(lastCommand("DeleteObject")).toMatchObject({ Key: KEY });
  });

  it("reports a delete failure rather than swallowing it", async () => {
    send.mockRejectedValue(awsError("InternalError", 500));

    await expect(provider().deleteObject(KEY)).rejects.toMatchObject({
      failure: STORAGE_PROVIDER_FAILURE.UNAVAILABLE,
    });
  });

  it("checks the bucket with a metadata call that creates nothing", async () => {
    send.mockResolvedValue({});

    await provider().checkBucket();

    expect(lastCommand("HeadBucket")).toEqual({
      Bucket: "application-uploads",
    });
    expect(commands.some((entry) => entry.name === "PutObject")).toBe(false);
  });

  it("releases the client on destroy", () => {
    provider().destroy();

    expect(destroy).toHaveBeenCalled();
  });
});

describe("translating a provider failure", () => {
  const cases = [
    ["NoSuchBucket", undefined, STORAGE_PROVIDER_FAILURE.BUCKET_NOT_FOUND],
    ["NoSuchKey", undefined, STORAGE_PROVIDER_FAILURE.NOT_FOUND],
    ["AccessDenied", 403, STORAGE_PROVIDER_FAILURE.ACCESS_DENIED],
    ["InvalidAccessKeyId", 403, STORAGE_PROVIDER_FAILURE.ACCESS_DENIED],
    ["SignatureDoesNotMatch", 403, STORAGE_PROVIDER_FAILURE.ACCESS_DENIED],
    ["TimeoutError", undefined, STORAGE_PROVIDER_FAILURE.UNAVAILABLE],
    ["InternalError", 500, STORAGE_PROVIDER_FAILURE.UNAVAILABLE],
  ] as const;

  it.each(cases)("maps %s to %s", async (name, status, expected) => {
    send.mockRejectedValue(awsError(name, status));

    await expect(provider().headObject(KEY)).rejects.toMatchObject({
      failure: expected,
    });
  });

  it("reads a bare NotFound as the caller's question, not the name's", async () => {
    // `HeadBucket` and `HeadObject` both answer a bare `NotFound`, so the name
    // alone cannot say which one is missing. Reading it the wrong way would let
    // a health check report a misconfiguration as a transient outage.
    send.mockRejectedValue(awsError("NotFound", 404));

    await expect(provider().headObject(KEY)).rejects.toMatchObject({
      failure: STORAGE_PROVIDER_FAILURE.NOT_FOUND,
    });

    send.mockRejectedValue(awsError("NotFound", 404));

    await expect(provider().checkBucket()).rejects.toMatchObject({
      failure: STORAGE_PROVIDER_FAILURE.BUCKET_NOT_FOUND,
    });
  });

  it("never carries the provider's message out", async () => {
    send.mockRejectedValue(awsError("InternalError", 500));

    const error = (await provider()
      .headObject(KEY)
      .catch((thrown: unknown) => thrown)) as Error;

    expect(error).toBeInstanceOf(StorageProviderError);
    expect(error.message).not.toContain("must never be surfaced");
    expect(error.message).not.toContain("application-uploads");
    expect(error.message).not.toContain("127.0.0.1");
  });

  it("passes its own error through unchanged", async () => {
    send.mockRejectedValue(
      new StorageProviderError(STORAGE_PROVIDER_FAILURE.NOT_FOUND),
    );

    await expect(provider().headObject(KEY)).rejects.toMatchObject({
      failure: STORAGE_PROVIDER_FAILURE.NOT_FOUND,
    });
  });
});
