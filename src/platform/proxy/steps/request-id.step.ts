import type { NextRequest, NextResponse } from "next/server";

import {
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "@/platform/observability/request-id.server";

/**
 * Resolves the correlation ID and places it on the incoming request headers.
 *
 * Writing the header before the locale step runs is what makes the value
 * available upstream: `next-intl` copies the request headers into its
 * `NextResponse.next({ request })` or `NextResponse.rewrite(url, { request })`
 * result, which is how Next.js forwards headers to server handling.
 *
 * A client-supplied value is only reused when it satisfies the bounded UUID v4
 * contract; anything else is replaced.
 */
export function applyRequestIdToRequest(request: NextRequest): string {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));

  request.headers.set(REQUEST_ID_HEADER, requestId);

  return requestId;
}

/** Returns the same correlation ID to the client on the outgoing response. */
export function applyRequestIdToResponse(
  response: NextResponse,
  requestId: string,
): void {
  response.headers.set(REQUEST_ID_HEADER, requestId);
}
