import { headers } from "next/headers";

import { serverEnv } from "@/config/env/index.server";
import {
  getSessionFromHeaders,
  toSessionViewer,
} from "@/platform/auth/session.server";

import { isAuthSessionDiagnosticEnabled } from "./auth-session-access";

/**
 * Reports whether the server-side session helper resolves a session for the
 * incoming request.
 *
 * It exists to prove that a Route Handler validates the session on the server
 * rather than trusting a cookie. It returns no token, cookie, authorization
 * header, IP address, user agent, ban metadata, or permission graph, and it is
 * unavailable outside development and test.
 */
export async function GET() {
  if (!isAuthSessionDiagnosticEnabled(serverEnv.APP_ENV)) {
    return new Response(null, {
      status: 404,
    });
  }

  const viewer = toSessionViewer(await getSessionFromHeaders(await headers()));

  if (!viewer) {
    return Response.json({
      authenticated: false,
    });
  }

  return Response.json({
    authenticated: true,
    user: {
      id: viewer.id,
      email: viewer.email,
    },
  });
}
