import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";

import {
  SECURITY_HEADERS,
  applySecurityHeaders,
} from "./security-headers.step";

const deferredHeaders = [
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "access-control-allow-origin",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "cross-origin-embedder-policy",
  "x-xss-protection",
];

describe("SECURITY_HEADERS", () => {
  it("declares exactly the baseline set", () => {
    expect(SECURITY_HEADERS).toEqual({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
  });

  it("excludes headers deferred to their own policy decision", () => {
    const declared = Object.keys(SECURITY_HEADERS).map((header) =>
      header.toLowerCase(),
    );

    for (const header of deferredHeaders) {
      expect(declared).not.toContain(header);
    }
  });
});

describe("applySecurityHeaders", () => {
  it("applies every declared header value", () => {
    const response = NextResponse.next();

    applySecurityHeaders(response);

    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(header)).toBe(value);
    }
  });

  it("adds no header outside the declared set", () => {
    const response = NextResponse.next();
    const before = new Set(response.headers.keys());

    applySecurityHeaders(response);

    const added = [...response.headers.keys()].filter(
      (header) => !before.has(header),
    );

    expect(added.sort()).toEqual(
      Object.keys(SECURITY_HEADERS)
        .map((header) => header.toLowerCase())
        .sort(),
    );
  });

  it("preserves redirect status, location, cookies, and other headers", () => {
    const response = NextResponse.redirect("http://localhost/ar?source=test", {
      status: 307,
    });

    response.headers.set("link", '<http://localhost/en>; rel="alternate"');
    response.cookies.set("APP_LOCALE", "ar", { path: "/" });

    applySecurityHeaders(response);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/ar?source=test",
    );
    expect(response.headers.get("link")).toBe(
      '<http://localhost/en>; rel="alternate"',
    );
    expect(response.cookies.get("APP_LOCALE")?.value).toBe("ar");
  });
});
