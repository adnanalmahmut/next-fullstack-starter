import type { NextResponse } from "next/server";

/**
 * The baseline response headers applied to every proxied response.
 *
 * Content Security Policy, Strict Transport Security, CORS, the Cross-Origin
 * isolation family, and nonces are deliberately absent: each one needs its own
 * documented policy decision because it can affect OAuth flows, uploads,
 * embedding, and deployment.
 */
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;

/**
 * Applies the baseline headers to an existing response.
 *
 * The response is mutated in place so redirect status, `Location`, rewrite
 * metadata, cookies, and any other header produced by `next-intl` or Next.js
 * survive untouched. No value derives from user input.
 */
export function applySecurityHeaders(response: NextResponse): void {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(header, value);
  }
}
