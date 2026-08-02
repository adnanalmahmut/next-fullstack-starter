import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStubPath = fileURLToPath(
  new URL("./tests/server-only.stub.ts", import.meta.url),
);

/**
 * The object storage integration suite, deliberately outside the default
 * configuration.
 *
 * `pnpm verify` must pass on a machine with no MinIO and no bucket anywhere, so
 * this suite is not a project of `vitest.config.ts`: it cannot be reached by
 * `pnpm test`, `pnpm test:unit`, or the coverage run. It is opted into with
 * `pnpm test:storage:integration`, and it is the only place a real object store
 * is required — PostgreSQL as well, because an upload intent is a row and the
 * guarantees under test are about the two agreeing.
 *
 * Files run one at a time. They share one bucket and one key prefix, and a
 * cleanup that lists that prefix must not run while another file is still
 * writing into it.
 *
 * The timeout is raised over the default because a single test here uploads
 * bytes over HTTP, verifies them, copies them server-side, and downloads them
 * again. That is four round trips to a container, not a slow assertion.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": srcPath,
      "server-only": serverOnlyStubPath,
    },
  },
  test: {
    name: "storage-integration",
    environment: "node",
    setupFiles: ["./tests/vitest.setup.ts"],
    include: ["tests/storage/**/*.storage.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
