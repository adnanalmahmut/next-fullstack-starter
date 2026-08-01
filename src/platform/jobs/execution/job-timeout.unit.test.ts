import { describe, expect, it, vi } from "vitest";

import { JobTimeoutError } from "./job-failure";
import { runWithJobTimeout } from "./job-timeout";

describe("a bounded attempt", () => {
  it("returns the handler's value when it finishes in time", async () => {
    await expect(
      runWithJobTimeout(1_000, true, async () => "value"),
    ).resolves.toBe("value");
  });

  it("propagates a handler failure unchanged", async () => {
    const failure = new Error("handler failed");

    await expect(
      runWithJobTimeout(1_000, true, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("hands the handler a signal that is not yet aborted", async () => {
    await runWithJobTimeout(1_000, true, async (signal) => {
      expect(signal.aborted).toBe(false);
    });
  });
});

describe("when the budget runs out", () => {
  it("aborts the signal rather than only racing", async () => {
    // A race alone resolves the caller while the work carries on in the
    // background, still holding a connection and still about to write.
    let sawAbort = false;

    await expect(
      runWithJobTimeout(
        20,
        true,
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              sawAbort = true;
              reject(new Error("aborted"));
            });
          }),
      ),
    ).rejects.toBeInstanceOf(JobTimeoutError);

    expect(sawAbort).toBe(true);
  });

  it("still awaits a handler that ignores the signal", async () => {
    // The attempt fails either way, but the worker slot is not released while
    // the work is still running: two copies of one job is the worse outcome.
    let finished = false;

    await expect(
      runWithJobTimeout(10, true, async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        finished = true;

        return "late";
      }),
    ).rejects.toBeInstanceOf(JobTimeoutError);

    expect(finished).toBe(true);
  });

  it("reports a late success as a timeout", async () => {
    // Reporting success would hide a job quietly outgrowing its budget until
    // the day it stops finishing at all.
    await expect(
      runWithJobTimeout(10, true, async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));

        return "late";
      }),
    ).rejects.toBeInstanceOf(JobTimeoutError);
  });

  it("reports the timeout rather than the handler's abort error", async () => {
    const error = await runWithJobTimeout(10, false, async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 40));

      throw signal.reason instanceof Error
        ? new Error("AbortError")
        : new Error("other");
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JobTimeoutError);
    expect((error as JobTimeoutError).retryable).toBe(false);
  });

  it("carries the definition's retryability", async () => {
    const failure = await runWithJobTimeout(
      10,
      true,
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
        }),
    ).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(JobTimeoutError);
    expect((failure as JobTimeoutError).retryable).toBe(true);
  });
});

describe("the timer", () => {
  it("is always cleared, so it cannot keep the event loop alive", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await runWithJobTimeout(1_000, true, async () => "value");
    await runWithJobTimeout(1_000, true, async () => {
      throw new Error("failed");
    }).catch(() => undefined);

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);

    clearTimeoutSpy.mockRestore();
  });
});
