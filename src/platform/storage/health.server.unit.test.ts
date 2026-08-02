import { beforeEach, describe, expect, it, vi } from "vitest";

const getStorageConfiguration = vi.hoisted(() => vi.fn());
const getStorageProvider = vi.hoisted(() => vi.fn());

vi.mock("./config", () => ({
  getStorageConfiguration,
  getStorageKeyScope: vi.fn(),
}));
vi.mock("./provider/storage-client.server", () => ({ getStorageProvider }));

const { checkStorageHealth, STORAGE_HEALTH_STATUS } =
  await import("./health.server");
const { STORAGE_PROVIDER_FAILURE, StorageProviderError } =
  await import("./provider/storage-provider");

const checkBucket = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getStorageConfiguration.mockReturnValue({ enabled: true });
  checkBucket.mockResolvedValue(undefined);
  getStorageProvider.mockReturnValue({ checkBucket });
});

describe("the four outcomes", () => {
  it("answers disabled from configuration alone", async () => {
    // A readiness probe on a project that stores nothing must cost no client,
    // no socket, and no DNS lookup.
    getStorageConfiguration.mockReturnValue({ enabled: false });

    await expect(checkStorageHealth()).resolves.toEqual({
      status: STORAGE_HEALTH_STATUS.DISABLED,
    });
    expect(getStorageProvider).not.toHaveBeenCalled();
  });

  it("answers healthy with a latency when the bucket answers", async () => {
    await expect(checkStorageHealth()).resolves.toEqual({
      status: STORAGE_HEALTH_STATUS.HEALTHY,
      latencyMs: expect.any(Number),
    });
  });

  it("answers misconfigured for a bucket that does not exist", async () => {
    // Restarting will not fix it, and a probe that retried forever would be
    // waiting for a deploy.
    checkBucket.mockRejectedValue(
      new StorageProviderError(STORAGE_PROVIDER_FAILURE.BUCKET_NOT_FOUND),
    );

    await expect(checkStorageHealth()).resolves.toEqual({
      status: STORAGE_HEALTH_STATUS.MISCONFIGURED,
    });
  });

  it("answers misconfigured for a credential the provider refuses", async () => {
    checkBucket.mockRejectedValue(
      new StorageProviderError(STORAGE_PROVIDER_FAILURE.ACCESS_DENIED),
    );

    await expect(checkStorageHealth()).resolves.toEqual({
      status: STORAGE_HEALTH_STATUS.MISCONFIGURED,
    });
  });

  it("answers unavailable when the provider cannot be reached", async () => {
    checkBucket.mockRejectedValue(
      new StorageProviderError(STORAGE_PROVIDER_FAILURE.UNAVAILABLE),
    );

    await expect(checkStorageHealth()).resolves.toEqual({
      status: STORAGE_HEALTH_STATUS.UNAVAILABLE,
    });
  });

  it("answers unavailable for a failure it does not recognize", async () => {
    checkBucket.mockRejectedValue(new TypeError("something else"));

    await expect(checkStorageHealth()).resolves.toEqual({
      status: STORAGE_HEALTH_STATUS.UNAVAILABLE,
    });
  });

  it("answers misconfigured when the storage variables do not parse", async () => {
    getStorageConfiguration.mockImplementation(() => {
      throw new Error("Invalid storage environment variables: STORAGE_BUCKET");
    });

    await expect(checkStorageHealth()).resolves.toEqual({
      status: STORAGE_HEALTH_STATUS.MISCONFIGURED,
    });
  });

  it("answers disabled when the provider turns out not to exist", async () => {
    getStorageProvider.mockReturnValue(null);

    await expect(checkStorageHealth()).resolves.toEqual({
      status: STORAGE_HEALTH_STATUS.DISABLED,
    });
  });
});

describe("what the result carries", () => {
  it("never carries a bucket, an endpoint, or a provider message", async () => {
    checkBucket.mockRejectedValue(
      Object.assign(
        new Error("NoSuchBucket: application-uploads at https://s3.example"),
        { name: "NoSuchBucket" },
      ),
    );

    const health = await checkStorageHealth();

    expect(JSON.stringify(health)).not.toContain("application-uploads");
    expect(JSON.stringify(health)).not.toContain("s3.example");
    expect(Object.keys(health)).toEqual(["status"]);
  });

  it("creates and deletes nothing", async () => {
    // A probe that round-tripped a test object would fill a bucket with garbage
    // and fail when the credentials are read-only.
    const provider = {
      checkBucket,
      deleteObject: vi.fn(),
      copyObjectConditionally: vi.fn(),
      createPresignedUpload: vi.fn(),
    };

    getStorageProvider.mockReturnValue(provider);

    await checkStorageHealth();

    expect(provider.deleteObject).not.toHaveBeenCalled();
    expect(provider.copyObjectConditionally).not.toHaveBeenCalled();
    expect(provider.createPresignedUpload).not.toHaveBeenCalled();
    expect(checkBucket).toHaveBeenCalledTimes(1);
  });
});
