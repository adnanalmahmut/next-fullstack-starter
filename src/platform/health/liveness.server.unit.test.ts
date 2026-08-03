import { beforeEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => vi.fn());

vi.mock("next/server", () => ({
  connection: () => connection() as Promise<void>,
}));

const { createLivenessHandler } = await import("./liveness.server");
const { LIVENESS_REPORT } = await import("./liveness");

/**
 * The liveness handler.
 *
 * `connection()` is mocked because it reads the Next.js work store, which exists
 * only inside a real request. What is being tested is that the handler calls it —
 * and calls it *before* answering — because that is the only thing standing
 * between this endpoint and being prerendered at build time under Cache
 * Components. A prerendered liveness answer would be produced by `next build`
 * rather than by the process being probed, and would carry whatever headers the
 * static path chose rather than `no-store`.
 */
beforeEach(() => {
  connection.mockReset();
  connection.mockResolvedValue(undefined);
});

describe("the handler", () => {
  it("answers 200 with the liveness document", async () => {
    const response = await createLivenessHandler()();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(LIVENESS_REPORT);
  });

  it("sets no-store", async () => {
    const response = await createLivenessHandler()();

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers a byte-identical body every time", async () => {
    const handler = createLivenessHandler();

    const first = await (await handler()).text();
    const second = await (await handler()).text();

    expect(first).toBe(second);
    expect(first).toBe('{"status":"live","code":"PROCESS_ALIVE"}');
  });

  it("builds a fresh response per call rather than sharing one", async () => {
    // A shared `Response` would have its body consumed by the first caller and
    // fail for the second.
    const handler = createLivenessHandler();
    const [first, second] = await Promise.all([handler(), handler()]);

    expect(first).not.toBe(second);
    await expect(first.json()).resolves.toEqual(LIVENESS_REPORT);
    await expect(second.json()).resolves.toEqual(LIVENESS_REPORT);
  });
});

describe("request-time rendering", () => {
  it("waits for a request before answering", async () => {
    await createLivenessHandler()();

    expect(connection).toHaveBeenCalledTimes(1);
  });

  it("calls it once per request, not once per handler", async () => {
    const handler = createLivenessHandler();

    await handler();
    await handler();

    expect(connection).toHaveBeenCalledTimes(2);
  });

  it("does not call it while the handler is being built", () => {
    createLivenessHandler();

    expect(connection).not.toHaveBeenCalled();
  });

  it("answers only after it resolves", async () => {
    let release: (() => void) | undefined;

    connection.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    let answered = false;

    const pending = createLivenessHandler()().then((response) => {
      answered = true;

      return response;
    });

    await Promise.resolve();
    expect(answered).toBe(false);

    release?.();

    await expect(pending).resolves.toBeInstanceOf(Response);
  });
});
