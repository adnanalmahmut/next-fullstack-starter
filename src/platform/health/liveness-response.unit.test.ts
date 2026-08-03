import { describe, expect, it } from "vitest";

const { HEALTH_RESPONSE_HEADERS } = await import("./health-headers");
const { LIVENESS_HTTP_STATUS, livenessResponse } =
  await import("./liveness-response");
const { readinessResponse } = await import("./readiness-response");
const { LIVENESS_REPORT } = await import("./liveness");
const { READINESS_HTTP_STATUS, UNKNOWN_READINESS_REPORT, toReadinessReport } =
  await import("./readiness");
const { DEPENDENCY_NAME, HEALTHY_DEPENDENCY } =
  await import("./dependency-check");

/**
 * The two serializers and the headers they share.
 *
 * They are separate modules so that the readiness document's types stay out of the
 * liveness route's import graph, and this file covers both.
 *
 * `no-store` is the load-bearing assertion. A readiness answer a CDN or a proxy
 * is allowed to reuse is worse than no answer: a cached `200` keeps sending
 * traffic to an instance that lost its database, and a cached `503` keeps it away
 * from one that recovered.
 */
const readyReport = toReadinessReport([
  { name: DEPENDENCY_NAME.DATABASE, report: HEALTHY_DEPENDENCY, durationMs: 1 },
]);

describe("headers", () => {
  it("declares no-store and JSON", () => {
    expect(HEALTH_RESPONSE_HEADERS).toEqual({
      "cache-control": "no-store",
      "content-type": "application/json",
    });
  });

  it.each([
    { name: "liveness", response: () => livenessResponse(LIVENESS_REPORT) },
    {
      name: "a ready readiness",
      response: () => readinessResponse(readyReport),
    },
    {
      name: "an unready readiness",
      response: () =>
        readinessResponse(
          UNKNOWN_READINESS_REPORT,
          READINESS_HTTP_STATUS.NOT_READY,
        ),
    },
  ])("sets no-store on $name", ({ response }) => {
    expect(response().headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    { name: "liveness", response: () => livenessResponse(LIVENESS_REPORT) },
    { name: "readiness", response: () => readinessResponse(readyReport) },
  ])("sets a JSON content type on $name", ({ response }) => {
    expect(response().headers.get("content-type")).toContain(
      "application/json",
    );
  });

  it.each([
    "etag",
    "last-modified",
    "expires",
    "set-cookie",
    "x-powered-by",
    "vary",
  ])("sets no %s header", (header) => {
    expect(livenessResponse(LIVENESS_REPORT).headers.get(header)).toBeNull();
    expect(readinessResponse(readyReport).headers.get(header)).toBeNull();
  });
});

describe("liveness response", () => {
  it("answers 200 and nothing else", async () => {
    const response = livenessResponse(LIVENESS_REPORT);

    expect(response.status).toBe(200);
    expect(LIVENESS_HTTP_STATUS).toBe(200);
    expect(await response.json()).toEqual(LIVENESS_REPORT);
  });

  it("writes the document flat, with no envelope", async () => {
    // The versioned API answers `{"data": …}`; an operational probe does not, so
    // external tooling matches on the document itself.
    const body = (await livenessResponse(LIVENESS_REPORT).json()) as Record<
      string,
      unknown
    >;

    expect(body).not.toHaveProperty("data");
    expect(body).not.toHaveProperty("error");
    expect(body.status).toBe("live");
  });
});

describe("readiness response", () => {
  it("answers 200 by default", () => {
    expect(readinessResponse(readyReport).status).toBe(200);
  });

  it("answers 503 when told to", () => {
    expect(
      readinessResponse(
        UNKNOWN_READINESS_REPORT,
        READINESS_HTTP_STATUS.NOT_READY,
      ).status,
    ).toBe(503);
  });

  it("writes the document flat, with no envelope", async () => {
    const body = (await readinessResponse(readyReport).json()) as Record<
      string,
      unknown
    >;

    expect(body).not.toHaveProperty("data");
    expect(body).not.toHaveProperty("error");
    expect(body).toEqual(readyReport);
  });

  it("has an empty body of no kind — every answer carries a document", async () => {
    for (const response of [
      livenessResponse(LIVENESS_REPORT),
      readinessResponse(readyReport),
      readinessResponse(
        UNKNOWN_READINESS_REPORT,
        READINESS_HTTP_STATUS.NOT_READY,
      ),
    ]) {
      expect((await response.text()).length).toBeGreaterThan(0);
    }
  });
});
