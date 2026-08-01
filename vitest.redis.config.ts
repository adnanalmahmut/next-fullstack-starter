import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStubPath = fileURLToPath(
  new URL("./tests/server-only.stub.ts", import.meta.url),
);

/**
 * The Redis integration suite, deliberately outside the default configuration.
 *
 * `pnpm verify` must pass on a machine with no Redis at all, so this suite is
 * not a project of `vitest.config.ts`: it cannot be reached by `pnpm test`,
 * `pnpm test:unit`, or the coverage run. It is opted into with
 * `pnpm test:redis:integration`, and it is the only place a real Redis server
 * is required.
 *
 * Files run one at a time. They share one Redis and one key scope, and a
 * cleanup that scans that scope must not run while another file is still
 * writing into it.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": srcPath,
      "server-only": serverOnlyStubPath,
    },
  },
  test: {
    name: "redis-integration",
    environment: "node",
    setupFiles: ["./tests/vitest.setup.ts"],
    include: ["tests/redis/**/*.redis.test.ts"],
    fileParallelism: false,
  },
});
