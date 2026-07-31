import type { NextRequest, NextResponse } from "next/server";

import { createProxyContext } from "./context";
import { applyLocaleRouting } from "./steps/locale.step";
import {
  applyRequestIdToRequest,
  applyRequestIdToResponse,
} from "./steps/request-id.step";
import { applySecurityHeaders } from "./steps/security-headers.step";

/**
 * The request pipeline, in execution order:
 *
 * 1. resolve the correlation ID and forward it on the request headers;
 * 2. classify the route;
 * 3. run locale negotiation, or skip it for API routes;
 * 4. apply baseline security headers;
 * 5. return the correlation ID on the response.
 *
 * Steps 4 and 5 mutate the response created by step 3 instead of constructing a
 * new one, so nothing produced by `next-intl` or Next.js is lost.
 */
export function runRequestPipeline(request: NextRequest): NextResponse {
  const requestId = applyRequestIdToRequest(request);
  const context = createProxyContext({ request, requestId });

  const response = applyLocaleRouting(context);

  applySecurityHeaders(response);
  applyRequestIdToResponse(response, context.requestId);

  return response;
}
