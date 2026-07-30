import "server-only";

import { performance } from "node:perf_hooks";

export type OperationTimer = Readonly<{
  elapsedMs: () => number;
}>;

export function startOperationTimer(): OperationTimer {
  const startedAt = performance.now();

  return {
    elapsedMs: () => {
      const durationMs = Math.max(0, performance.now() - startedAt);

      return Math.round(durationMs * 1_000) / 1_000;
    },
  };
}
