import {
  createReadinessHandler,
  createWebReadinessRegistry,
} from "@/platform/health/readiness.server";

/**
 * `GET /api/health/ready`
 *
 * A declaration, and nothing else. The registry is built once, here, when the
 * module is evaluated, and is never replaced — which is what makes the set of
 * checks a property of the deployment rather than of whatever happened to be
 * imported before the first request arrived.
 *
 * It answers `200` when every required dependency is healthy and `503` when one
 * is not. It never checks the queue, the worker, or the outbox: a request records
 * work by writing a row in its own transaction, so a web instance with no worker
 * anywhere is ready.
 */
export const GET = createReadinessHandler(createWebReadinessRegistry());
