import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadEnvConfig } = vi.hoisted(() => ({ loadEnvConfig: vi.fn() }));

vi.mock("@next/env", () => ({ loadEnvConfig }));

const { loadWorkerEnvironment, WORKER_EXIT_CODE } = await import("./bootstrap");

const environment = process.env as Record<string, string | undefined>;
const originalNodeEnv = environment.NODE_ENV;
const originalAppEnv = environment.APP_ENV;

beforeEach(() => {
  loadEnvConfig.mockClear();
  delete environment.NODE_ENV;
  delete environment.APP_ENV;
});

afterEach(() => {
  environment.NODE_ENV = originalNodeEnv;
  environment.APP_ENV = originalAppEnv;
});

describe("a worker loads its own environment", () => {
  it("loads the .env files, because Next.js is not running", () => {
    loadWorkerEnvironment();

    expect(loadEnvConfig).toHaveBeenCalledWith(process.cwd());
  });

  it.each([
    { appEnvironment: "development", nodeEnvironment: "development" },
    { appEnvironment: "test", nodeEnvironment: "test" },
    { appEnvironment: "staging", nodeEnvironment: "production" },
    { appEnvironment: "production", nodeEnvironment: "production" },
  ])(
    "derives NODE_ENV=$nodeEnvironment from APP_ENV=$appEnvironment",
    ({ appEnvironment, nodeEnvironment }) => {
      // `APP_ENV` is already the authoritative answer to "which environment is
      // this", so taking `NODE_ENV` from it keeps one source of truth and needs
      // no platform-specific prefix in a package script.
      environment.APP_ENV = appEnvironment;

      loadWorkerEnvironment();

      expect(environment.NODE_ENV).toBe(nodeEnvironment);
    },
  );

  it("falls back to production when APP_ENV says nothing usable", () => {
    // The safe fallback is the strict one: a real logger level, no development
    // conveniences, and no accidental test behaviour.
    environment.APP_ENV = "something-else";

    loadWorkerEnvironment();

    expect(environment.NODE_ENV).toBe("production");
  });

  it("leaves an explicitly set NODE_ENV alone", () => {
    environment.NODE_ENV = "development";
    environment.APP_ENV = "production";

    loadWorkerEnvironment();

    expect(environment.NODE_ENV).toBe("development");
  });
});

describe("the exit codes", () => {
  it("separate a misconfiguration from a crash", () => {
    // A supervisor should stop restarting the first one in a tight loop.
    expect(WORKER_EXIT_CODE.OK).toBe(0);
    expect(WORKER_EXIT_CODE.FAILED).not.toBe(WORKER_EXIT_CODE.MISCONFIGURED);
    expect(WORKER_EXIT_CODE.MISCONFIGURED).toBeGreaterThan(0);
  });
});
