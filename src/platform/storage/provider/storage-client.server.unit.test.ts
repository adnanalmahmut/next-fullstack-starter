import { beforeEach, describe, expect, it, vi } from "vitest";

const getStorageConfiguration = vi.hoisted(() => vi.fn());
const createS3StorageProvider = vi.hoisted(() => vi.fn());

vi.mock("../config", () => ({
  getStorageConfiguration,
  getStorageKeyScope: vi.fn(),
}));
vi.mock("./s3-storage-provider.server", () => ({ createS3StorageProvider }));

const { closeStorageClient, getStorageProvider, requireStorageProvider } =
  await import("./storage-client.server");

const destroy = vi.fn();

const enabled = {
  enabled: true,
  region: "us-east-1",
  bucket: "application-uploads",
  forcePathStyle: false,
  keyPrefix: "next-fullstack-starter",
  connectTimeoutMs: 5_000,
  requestTimeoutMs: 15_000,
  uploadUrlTtlSeconds: 900,
  downloadUrlTtlSeconds: 300,
  uploadIntentTtlSeconds: 900,
  finalizeLeaseMs: 30_000,
  maxUploadBytes: 4096,
};

beforeEach(() => {
  closeStorageClient();
  vi.clearAllMocks();
  createS3StorageProvider.mockImplementation(() => ({ destroy }));
  getStorageConfiguration.mockReturnValue(enabled);
});

describe("when storage is disabled", () => {
  it("answers null and builds nothing", async () => {
    getStorageConfiguration.mockReturnValue({ ...enabled, enabled: false });

    expect(getStorageProvider()).toBeNull();
    expect(createS3StorageProvider).not.toHaveBeenCalled();
  });

  it("refuses rather than returning null when a caller requires it", () => {
    getStorageConfiguration.mockReturnValue({ ...enabled, enabled: false });

    // A refusal, not a defect: nothing was written, and the same call would
    // succeed on a deployment that has a bucket.
    expect(() => requireStorageProvider()).toThrowError(
      expect.objectContaining({ code: "DEPENDENCY_UNAVAILABLE" }),
    );
  });
});

describe("when storage is enabled", () => {
  it("builds the client on first use and reuses it", () => {
    const first = getStorageProvider();
    const second = getStorageProvider();

    expect(first).toBe(second);
    expect(createS3StorageProvider).toHaveBeenCalledTimes(1);
  });

  it("builds nothing until somebody asks", () => {
    // The whole area is arranged around this: a process that never uploads
    // never resolves the endpoint's hostname and never reads a credential.
    expect(createS3StorageProvider).not.toHaveBeenCalled();
  });

  it("hands the same client to both accessors", () => {
    expect(requireStorageProvider()).toBe(getStorageProvider());
  });
});

describe("closing the client", () => {
  it("releases its sockets and forgets it", () => {
    getStorageProvider();
    closeStorageClient();

    expect(destroy).toHaveBeenCalledTimes(1);

    getStorageProvider();

    expect(createS3StorageProvider).toHaveBeenCalledTimes(2);
  });

  it("is safe to call when nothing was ever built", () => {
    expect(() => {
      closeStorageClient();
    }).not.toThrow();
    expect(destroy).not.toHaveBeenCalled();
  });
});
