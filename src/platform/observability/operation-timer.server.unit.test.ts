import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startOperationTimer } from "./operation-timer.server";

describe("operation timer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a monotonic duration in milliseconds", () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(112.345_67);

    const timer = startOperationTimer();
    const durationMs = timer.elapsedMs();

    expect(durationMs).toBe(12.346);
    expect(Number.isFinite(durationMs)).toBe(true);
  });

  it("never reports a negative duration", () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(99);

    expect(startOperationTimer().elapsedMs()).toBe(0);
  });
});
