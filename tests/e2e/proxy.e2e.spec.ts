import type { APIResponse } from "@playwright/test";
import { expect, test } from "@playwright/test";

const requestIdHeader = "x-request-id";
const localeCookieName = "APP_LOCALE";
const diagnosticRoute = "/api/diagnostics/request-context";
const validRequestId = "123e4567-e89b-42d3-a456-426614174000";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const securityHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function expectSecurityHeaders(response: APIResponse) {
  const headers = response.headers();

  for (const [header, value] of Object.entries(securityHeaders)) {
    expect(headers[header], header).toBe(value);
  }
}

function setCookieValues(response: APIResponse): string[] {
  return response
    .headersArray()
    .filter(({ name }) => name.toLowerCase() === "set-cookie")
    .map(({ value }) => value);
}

test.describe("proxy request pipeline", () => {
  test.describe("locale negotiation", () => {
    test("redirects an unprefixed pathname and keeps the search parameters", async ({
      request,
    }) => {
      const response = await request.get("/reports?source=e2e&page=2", {
        maxRedirects: 0,
      });

      expect(response.status()).toBe(307);
      expect(response.headers()["location"]).toBe(
        "/ar/reports?source=e2e&page=2",
      );
      expectSecurityHeaders(response);
      expect(response.headers()[requestIdHeader]).toMatch(requestIdPattern);
    });

    test("synchronizes the locale cookie on the redirect response", async ({
      request,
    }) => {
      const response = await request.get("/", { maxRedirects: 0 });

      expect(response.status()).toBe(307);
      expect(response.headers()["location"]).toBe("/ar");
      expect(setCookieValues(response).join(";")).toContain(
        `${localeCookieName}=ar`,
      );
    });

    for (const { pathname, locale } of [
      { pathname: "/ar", locale: "ar" },
      { pathname: "/en", locale: "en" },
    ]) {
      test(`serves ${pathname} directly with the baseline headers`, async ({
        request,
      }) => {
        const response = await request.get(pathname, { maxRedirects: 0 });

        expect(response.status()).toBe(200);
        expect(response.headers()["location"]).toBeUndefined();
        expect(setCookieValues(response).join(";")).toContain(
          `${localeCookieName}=${locale}`,
        );
        expectSecurityHeaders(response);
        expect(response.headers()[requestIdHeader]).toMatch(requestIdPattern);
      });
    }

    test("keeps internationalizing an unmatched page pathname", async ({
      request,
    }) => {
      const response = await request.get("/unmatched", { maxRedirects: 0 });

      expect(response.status()).toBe(307);
      expect(response.headers()["location"]).toBe("/ar/unmatched");
      expectSecurityHeaders(response);
    });
  });

  test.describe("request ID propagation", () => {
    test("generates a request ID that reaches server handling", async ({
      request,
    }) => {
      const response = await request.get(diagnosticRoute);
      const responseRequestId = response.headers()[requestIdHeader];
      const body = (await response.json()) as { requestId: string | null };

      expect(response.status()).toBe(200);
      expect(responseRequestId).toMatch(requestIdPattern);
      expect(body.requestId).toBe(responseRequestId);
    });

    test("keeps a valid incoming request ID upstream and downstream", async ({
      request,
    }) => {
      const response = await request.get(diagnosticRoute, {
        headers: {
          [requestIdHeader]: validRequestId,
        },
      });
      const body = (await response.json()) as { requestId: string | null };

      expect(response.headers()[requestIdHeader]).toBe(validRequestId);
      expect(body.requestId).toBe(validRequestId);
    });

    test("replaces an invalid incoming request ID everywhere", async ({
      request,
    }) => {
      const invalidRequestId = "not-a-valid-request-id";
      const response = await request.get(diagnosticRoute, {
        headers: {
          [requestIdHeader]: invalidRequestId,
        },
      });
      const responseRequestId = response.headers()[requestIdHeader];
      const body = (await response.json()) as { requestId: string | null };

      expect(responseRequestId).toMatch(requestIdPattern);
      expect(responseRequestId).not.toBe(invalidRequestId);
      expect(body.requestId).toBe(responseRequestId);
    });

    test("does not reflect incoming request headers back to the client", async ({
      request,
    }) => {
      const response = await request.get("/ar", {
        headers: {
          authorization: "Bearer e2e-diagnostic-value",
        },
      });
      const headerNames = response
        .headersArray()
        .map(({ name }) => name.toLowerCase());

      expect(headerNames).not.toContain("authorization");
      expect(
        headerNames.filter((name) => name.startsWith("x-middleware-")),
      ).toEqual([]);
      expect(JSON.stringify(response.headers())).not.toContain(
        "e2e-diagnostic-value",
      );
    });
  });

  test.describe("API routes", () => {
    test("receives the baseline headers without locale handling", async ({
      request,
    }) => {
      const response = await request.get(diagnosticRoute, {
        maxRedirects: 0,
      });

      expect(response.status()).toBe(200);
      expect(response.headers()["location"]).toBeUndefined();
      expect(response.headers()["link"]).toBeUndefined();
      expect(setCookieValues(response)).toEqual([]);
      expectSecurityHeaders(response);
      expect(response.headers()[requestIdHeader]).toMatch(requestIdPattern);
    });

    test("does not internationalize an unmatched API pathname", async ({
      request,
    }) => {
      const response = await request.get("/api/unmatched", {
        maxRedirects: 0,
      });

      expect(response.status()).toBe(404);
      expect(response.headers()["location"]).toBeUndefined();
      expectSecurityHeaders(response);
    });
  });

  test.describe("matcher scope", () => {
    test("does not proxy static files", async ({ request }) => {
      const response = await request.get("/favicon.ico", {
        maxRedirects: 0,
      });

      expect(response.status()).toBe(200);
      expect(response.headers()[requestIdHeader]).toBeUndefined();
      expect(response.headers()["x-frame-options"]).toBeUndefined();
    });

    test("does not proxy Next.js internal paths", async ({ request }) => {
      const response = await request.get("/_next/static/chunks/unmatched", {
        maxRedirects: 0,
      });

      expect(response.headers()[requestIdHeader]).toBeUndefined();
      expect(response.headers()["x-frame-options"]).toBeUndefined();
    });
  });
});
