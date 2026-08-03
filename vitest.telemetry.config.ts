import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStubPath = fileURLToPath(
  new URL("./tests/server-only.stub.ts", import.meta.url),
);

/**
 * The telemetry integration suite, deliberately outside the default configuration.
 *
 * `pnpm verify` must pass on a machine with no collector anywhere, and must pass
 * *while proving* that nothing was exported. So this suite is not a project of
 * `vitest.config.ts`: it cannot be reached by `pnpm test`, `pnpm test:unit`, or the
 * coverage run. It is opted into with `pnpm test:telemetry:integration`, and it is
 * the only place telemetry is switched on.
 *
 * It needs no service of any kind. The receiver is an ephemeral `node:http` server
 * started inside the tests and closed in `finally`, which is a deliberate choice
 * over running a real OpenTelemetry Collector: an in-process receiver has nothing
 * to provision, nothing to wait for, and no port left listening after the run —
 * and it can assert on the exact bytes the exporter put on the wire, which is the
 * whole point of exercising the real exporters rather than an in-memory one.
 *
 * Files run one at a time. Every one of them registers global OpenTelemetry
 * providers, and two files doing that concurrently would each see the other's
 * tracer.
 *
 * The timeout is raised over the default because a single test here starts an SDK,
 * produces spans, waits for a batch to be exported over HTTP, and shuts everything
 * down. That is real I/O and a real batch delay, not a slow assertion.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": srcPath,
      "server-only": serverOnlyStubPath,
    },
  },
  test: {
    name: "telemetry-integration",
    environment: "node",
    setupFiles: ["./tests/vitest.setup.ts"],
    include: ["tests/telemetry/**/*.telemetry.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
