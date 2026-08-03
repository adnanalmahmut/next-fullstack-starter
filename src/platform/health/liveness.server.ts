import "server-only";

import { connection } from "next/server";

import { livenessResponse } from "./liveness-response";
import { LIVENESS_REPORT } from "./liveness";

/**
 * The liveness entry point, and the second controlled entry point of this
 * platform.
 *
 * It exists as its own file, separate from the other two, for a reason that is
 * structural rather than stylistic. `readiness.server.ts` imports
 * `@/platform/database`, `@/platform/redis`, and `@/platform/storage` — and
 * importing `@/platform/database` constructs the Prisma client at module
 * evaluation. If the liveness route shared an entry point with it, then the
 * endpoint whose entire purpose is to answer without touching anything would open
 * a connection pool before serving its first request, and the promise that it
 * works when every external service is down would be false in the one way nobody
 * would notice: it would still return `200`, having quietly built three clients.
 *
 * So the graph is kept apart rather than the intent being documented and hoped
 * for. From this file the reachable set is four constant modules — `liveness.ts`,
 * `health-code.ts`, `health-status.ts`, `health-headers.ts` — one serializer, and
 * `next/server`. The serializer is split from the readiness one for the same
 * reason: a shared module would put the readiness document's types, and the
 * dependency port behind them, in this graph. A dependency-cruiser reachability
 * rule and a contract test both assert the set, so an ordinary-looking import
 * added here later fails the build rather than silently costing a connection pool.
 *
 * ## Why `connection()`
 *
 * This project runs with Cache Components enabled. Under it a `GET` Route
 * Handler that reads no request data and performs no uncached I/O is prerendered
 * at build time — and this handler is exactly that shape, so it would be turned
 * into a static document. A prerendered liveness answer is the wrong thing twice
 * over: the body would be produced by `next build` rather than by the process
 * being probed, and its headers would be whatever the static path decides rather
 * than the `no-store` this platform guarantees.
 *
 * `connection()` is the supported way to say "this must run when a request
 * arrives". `export const dynamic = "force-dynamic"` is not an alternative here:
 * it was removed in Next.js 16 when Cache Components is enabled.
 *
 * It is called in the factory rather than in `route.ts` on purpose. A guarantee
 * that has to be restated in every route file is a guarantee that will be
 * missing from the next one.
 */
export function createLivenessHandler(): () => Promise<Response> {
  return async () => {
    await connection();

    return livenessResponse(LIVENESS_REPORT);
  };
}
