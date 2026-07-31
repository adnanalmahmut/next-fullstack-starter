import type { NextRequest } from "next/server";

import { runRequestPipeline } from "./platform/proxy/compose";

export function proxy(request: NextRequest) {
  return runRequestPipeline(request);
}

export const config = {
  matcher: [
    // Application pages, excluding Next.js internals, hosting internals, and
    // any path that carries a file extension.
    "/((?!_next|_vercel|.*\\..*).*)",
    // API routes, including paths that carry a file extension.
    "/api/:path*",
  ],
};
