import "server-only";

import { startOperationTimer } from "@/platform/observability/operation-timer.server";

import {
  unhealthyDependency,
  type DependencyCheck,
  type DependencyCheckResult,
} from "./dependency-check";
import type { HealthRegistry } from "./health-registry";

/**
 * Runs a registry's checks, and cannot fail.
 *
 * Two properties are the whole value of this file.
 *
 * **Containment.** Every failure is converted into a result. A check that
 * rejects, a check that throws synchronously, a check that returns a rejected
 * promise, and a check that never settles all produce the same thing: an
 * `unhealthy` report carrying the code that check declared. Nothing propagates
 * to the caller, so the readiness handler has no error path to get wrong and a
 * CLI has no stack trace to print. That is not defensive coding for its own
 * sake — the one moment a probe is called is the moment something is broken, and
 * a probe that throws during an incident is a probe that tells you nothing.
 *
 * **Bounding.** Each check is bounded independently rather than the batch being
 * bounded as a whole. A shared deadline would let a slow storage check consume
 * the budget a database check needed, so a single degraded optional dependency
 * would make a required one look unavailable — the exact inversion a readiness
 * probe must not produce.
 *
 * They run concurrently, because a probe that checked three dependencies in
 * sequence would take as long as their sum on a bad day. The concurrency is
 * bounded by construction: the registry is a fixed, small, immutable list built
 * at composition, so there is no input that can widen it. `Promise.all` is safe
 * here precisely because `runDependencyCheck` never rejects.
 */
async function withDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("The health check exceeded its budget."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    // Cleared on success, on failure, and on timeout. A readiness endpoint is
    // called for the lifetime of a deployment; a timer left behind on any of
    // those paths is a leak that only shows up in a long-running process, which
    // is the one place nobody is watching.
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function runDependencyCheck(
  check: DependencyCheck,
): Promise<DependencyCheckResult> {
  const timer = startOperationTimer();

  try {
    const report = await withDeadline(() => check.run(), check.timeoutMs);

    return { name: check.name, report, durationMs: timer.elapsedMs() };
  } catch {
    // The caught value is deliberately not read. It is whatever a driver, an
    // SDK, or the deadline above produced, and none of that belongs in a health
    // result — the declared code is the entire public answer.
    return {
      name: check.name,
      report: unhealthyDependency(check.failureCode),
      durationMs: timer.elapsedMs(),
    };
  }
}

export async function runHealthChecks(
  registry: HealthRegistry,
): Promise<readonly DependencyCheckResult[]> {
  return Promise.all(registry.checks.map((check) => runDependencyCheck(check)));
}
