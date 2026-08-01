import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStubPath = fileURLToPath(
  new URL("./tests/server-only.stub.ts", import.meta.url),
);

/**
 * The background-jobs integration suite, deliberately outside the default
 * configuration.
 *
 * `pnpm verify` must pass on a machine with no Redis and no worker at all, so
 * this suite is not a project of `vitest.config.ts`: it cannot be reached by
 * `pnpm test`, `pnpm test:unit`, or the coverage run. It is opted into with
 * `pnpm test:jobs:integration`, and it is the only place a real queue is
 * required — PostgreSQL as well, because the outbox is a table and the
 * guarantees being tested are transactional.
 *
 * Files run one at a time. Each starts its own worker and dispatcher against a
 * queue prefix scoped to the run, and a file that cleaned up while another was
 * still consuming would delete jobs out from under it.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": srcPath,
      "server-only": serverOnlyStubPath,
    },
  },
  test: {
    name: "jobs-integration",
    environment: "node",
    setupFiles: ["./tests/vitest.setup.ts"],
    include: ["tests/jobs/**/*.jobs.test.ts"],
    fileParallelism: false,
  },
});
