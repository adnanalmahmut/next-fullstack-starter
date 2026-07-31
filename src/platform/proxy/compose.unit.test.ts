import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { i18nConfig } from "@/i18n/config";
import { REQUEST_ID_HEADER } from "@/platform/observability/request-id.server";

import { runRequestPipeline } from "./compose";
import { SECURITY_HEADERS } from "./steps/security-headers.step";

const localeCookieName = i18nConfig.localeCookie.name;
const validRequestId = "123e4567-e89b-42d3-a456-426614174000";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Next.js encodes upstream request-header overrides as `x-middleware-request-*`
 * response headers and strips them before the client sees the response.
 */
function upstreamHeader(response: Response, header: string): string | null {
  return response.headers.get(`x-middleware-request-${header}`);
}

function clientVisibleHeaders(response: Response): string[] {
  return [...response.headers.keys()]
    .filter((header) => !header.startsWith("x-middleware-"))
    .sort();
}

function createRequest(
  pathname: string,
  options: { requestId?: string; localeCookie?: string } = {},
): NextRequest {
  const request = new NextRequest(
    `http://localhost${pathname}`,
    options.requestId === undefined
      ? undefined
      : {
          headers: {
            [REQUEST_ID_HEADER]: options.requestId,
          },
        },
  );

  if (options.localeCookie !== undefined) {
    request.cookies.set(localeCookieName, options.localeCookie);
  }

  return request;
}

describe("runRequestPipeline", () => {
  describe("locale routing", () => {
    it("redirects an unprefixed pathname to the default locale", () => {
      const response = runRequestPipeline(createRequest("/"));

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("http://localhost/ar");
    });

    it("preserves the query string while redirecting", () => {
      const response = runRequestPipeline(
        createRequest("/reports?source=pipeline&page=2"),
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "http://localhost/ar/reports?source=pipeline&page=2",
      );
    });

    it.each(["/ar", "/en", "/ar/design-system", "/en/design-system"])(
      "serves %s without a redirect",
      (pathname) => {
        const response = runRequestPipeline(createRequest(pathname));

        expect(response.status).toBe(200);
        expect(response.headers.get("location")).toBeNull();
      },
    );

    it("synchronizes the locale cookie when it does not match the URL", () => {
      const response = runRequestPipeline(
        createRequest("/en", { localeCookie: "ar" }),
      );

      expect(response.cookies.get(localeCookieName)?.value).toBe("en");
    });

    it("leaves the locale cookie untouched when it already matches", () => {
      const response = runRequestPipeline(
        createRequest("/en", { localeCookie: "en" }),
      );

      expect(response.cookies.get(localeCookieName)).toBeUndefined();
    });

    it("keeps the alternate-links header produced by next-intl", () => {
      const response = runRequestPipeline(createRequest("/ar"));

      expect(response.headers.get("link")).toContain('hreflang="en"');
    });
  });

  describe("API routes", () => {
    it("does not redirect an API pathname", () => {
      const response = runRequestPipeline(
        createRequest("/api/diagnostics/request-context"),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    });

    it("does not write a locale cookie or alternate links", () => {
      const response = runRequestPipeline(createRequest("/api/v1/products"));

      expect(response.cookies.get(localeCookieName)).toBeUndefined();
      expect(response.headers.get("link")).toBeNull();
    });
  });

  describe("request ID propagation", () => {
    it.each(["/ar", "/api/diagnostics/request-context"])(
      "forwards the generated request ID upstream and back for %s",
      (pathname) => {
        const response = runRequestPipeline(createRequest(pathname));
        const responseRequestId = response.headers.get(REQUEST_ID_HEADER);

        expect(responseRequestId).toMatch(requestIdPattern);
        expect(upstreamHeader(response, REQUEST_ID_HEADER)).toBe(
          responseRequestId,
        );
      },
    );

    it("reuses a valid incoming request ID", () => {
      const response = runRequestPipeline(
        createRequest("/ar", { requestId: validRequestId }),
      );

      expect(response.headers.get(REQUEST_ID_HEADER)).toBe(validRequestId);
      expect(upstreamHeader(response, REQUEST_ID_HEADER)).toBe(validRequestId);
    });

    it("replaces an invalid incoming request ID", () => {
      const response = runRequestPipeline(
        createRequest("/ar", { requestId: "not-a-request-id" }),
      );
      const responseRequestId = response.headers.get(REQUEST_ID_HEADER);

      expect(responseRequestId).toMatch(requestIdPattern);
      expect(responseRequestId).not.toBe("not-a-request-id");
      expect(upstreamHeader(response, REQUEST_ID_HEADER)).toBe(
        responseRequestId,
      );
    });
  });

  describe("response shape", () => {
    it.each([
      "/",
      "/ar",
      "/en",
      "/api/diagnostics/request-context",
      "/ar/unmatched",
    ])("applies every baseline security header to %s", (pathname) => {
      const response = runRequestPipeline(createRequest(pathname));

      for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
        expect(response.headers.get(header)).toBe(value);
      }
    });

    it("exposes only intended headers to the client", () => {
      const request = new NextRequest("http://localhost/api/v1/products", {
        headers: {
          authorization: "Bearer diagnostic-value",
          cookie: `${localeCookieName}=ar`,
        },
      });

      expect(clientVisibleHeaders(runRequestPipeline(request))).toEqual([
        "permissions-policy",
        "referrer-policy",
        "x-content-type-options",
        "x-frame-options",
        REQUEST_ID_HEADER,
      ]);
    });
  });
});
