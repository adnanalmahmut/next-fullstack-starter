import { afterEach, describe, expect, it, vi } from "vitest";

import { onRequestError, register } from "./instrumentation";

const request = {
  path: "/ar/private?token=private",
  method: "GET",
  headers: {
    "x-request-id": "123e4567-e89b-42d3-a456-426614174000",
  },
};

const context = {
  routerKind: "App Router" as const,
  routePath: "/[locale]/private",
  routeType: "render" as const,
  revalidateReason: undefined,
};

describe("Next.js instrumentation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not load Node observability in a non-Node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");

    await expect(register()).resolves.toBeUndefined();
    await expect(
      onRequestError(new Error("private"), request, context),
    ).resolves.toBeUndefined();
  });

  it("delegates Node registration and error reporting safely", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");

    await expect(register()).resolves.toBeUndefined();
    await expect(register()).resolves.toBeUndefined();
    await expect(
      onRequestError(new Error("private"), request, context),
    ).resolves.toBeUndefined();
  });
});
