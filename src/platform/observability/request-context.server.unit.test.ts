import { describe, expect, it } from "vitest";

import {
  getRequestContext,
  requireRequestContext,
  runWithRequestContext,
} from "./request-context.server";

describe("request context", () => {
  it("is unavailable outside a request scope", () => {
    expect(getRequestContext()).toBeUndefined();
    expect(() => requireRequestContext()).toThrow(
      "Request context is not available.",
    );
  });

  it("is available through synchronous and asynchronous work", async () => {
    const context = {
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      route: "/[locale]",
    };

    const observed = await runWithRequestContext(context, async () => {
      expect(requireRequestContext()).toEqual(context);
      await Promise.resolve().then(() => Promise.resolve());
      return requireRequestContext();
    });

    expect(observed).toEqual(context);
    expect(getRequestContext()).toBeUndefined();
  });

  it("restores an outer context after a nested scope", () => {
    const outer = { requestId: "123e4567-e89b-42d3-a456-426614174000" };
    const inner = { requestId: "223e4567-e89b-42d3-a456-426614174000" };

    runWithRequestContext(outer, () => {
      expect(requireRequestContext()).toEqual(outer);

      runWithRequestContext(inner, () => {
        expect(requireRequestContext()).toEqual(inner);
      });

      expect(requireRequestContext()).toEqual(outer);
    });
  });

  it("isolates concurrent request scopes", async () => {
    const requestIds = [
      "123e4567-e89b-42d3-a456-426614174000",
      "223e4567-e89b-42d3-a456-426614174000",
    ];

    const observed = await Promise.all(
      requestIds.map((requestId) =>
        runWithRequestContext({ requestId }, async () => {
          await Promise.resolve();
          return requireRequestContext().requestId;
        }),
      ),
    );

    expect(observed).toEqual(requestIds);
    expect(getRequestContext()).toBeUndefined();
  });

  it("preserves callback return values", () => {
    expect(
      runWithRequestContext(
        { requestId: "123e4567-e89b-42d3-a456-426614174000" },
        () => "result",
      ),
    ).toBe("result");
  });

  it("rethrows the original callback error and clears the context", () => {
    const failure = new Error("operation failed");

    expect(() =>
      runWithRequestContext(
        { requestId: "123e4567-e89b-42d3-a456-426614174000" },
        () => {
          throw failure;
        },
      ),
    ).toThrow(failure);
    expect(getRequestContext()).toBeUndefined();
  });

  it("rejects with the original asynchronous error and clears the context", async () => {
    const failure = new Error("async operation failed");

    await expect(
      runWithRequestContext(
        { requestId: "123e4567-e89b-42d3-a456-426614174000" },
        async () => {
          await Promise.resolve();
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(getRequestContext()).toBeUndefined();
  });
});
