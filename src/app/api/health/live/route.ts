import { createLivenessHandler } from "@/platform/health/liveness.server";

/**
 * `GET /api/health/live`
 *
 * A declaration, and nothing else. The handler is built by the health platform;
 * this file names the path.
 *
 * It imports the minimal liveness entry point rather than the readiness one,
 * because that one reaches `@/platform/database` and would construct a Prisma
 * client here. That is enforced, not remembered: a dependency-cruiser
 * reachability rule fails the build if this file can reach persistence, Redis,
 * object storage, a queue, or authentication, transitively.
 */
export const GET = createLivenessHandler();
