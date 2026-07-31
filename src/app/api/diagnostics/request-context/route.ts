import { headers } from "next/headers";

import { serverEnv } from "@/config/env/index.server";
import { REQUEST_ID_HEADER } from "@/platform/observability/request-id.server";

import { isRequestContextDiagnosticEnabled } from "./request-context-access";

/**
 * Reports the correlation ID that reached server handling.
 *
 * The proxy writes `x-request-id` on both the upstream request and the outgoing
 * response. Only a handler can observe the upstream value, so this route exists
 * to prove that propagation instead of trusting the response header alone.
 *
 * It carries no business behavior and is unavailable outside development and
 * test.
 */
export async function GET() {
  if (!isRequestContextDiagnosticEnabled(serverEnv.APP_ENV)) {
    return new Response(null, {
      status: 404,
    });
  }

  const requestHeaders = await headers();

  return Response.json({
    requestId: requestHeaders.get(REQUEST_ID_HEADER),
  });
}
