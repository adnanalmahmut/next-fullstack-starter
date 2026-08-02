import { availableParallelism, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStubPath = fileURLToPath(
  new URL("./tests/server-only.stub.ts", import.meta.url),
);

/**
 * How many test workers may run at once.
 *
 * Vitest sizes its pool from the core count alone, and that is the wrong
 * question here. A worker in this repository loads Next.js, the generated
 * Prisma client, and — in the contract suites — a full ESLint instance with its
 * flat config and plugins, which is several hundred megabytes each. Core count
 * says nothing about whether that fits.
 *
 * It bites on exactly the machine this is most likely to be developed on: a WSL
 * guest reports every logical core of the host but is given a small fraction of
 * its memory, so a 22-core, 8 GB guest spawns 21 workers and the kernel starts
 * killing things. What it kills is not always a worker — a PostgreSQL container
 * is a much larger target — so the failure arrives as an unreachable database
 * or a hung ESLint rather than as an out-of-memory error, which is why it is
 * worth naming here.
 *
 * So the bound is whichever is smaller: the cores actually available, or one
 * worker per 1.5 GB of RAM. On a well-provisioned machine the core count wins
 * and nothing changes; on CI it resolves to the same handful of workers it
 * would have used anyway.
 */
const WORKER_MEMORY_BUDGET_BYTES = 1.5 * 1024 * 1024 * 1024;

const maxWorkers = Math.max(
  1,
  Math.min(
    availableParallelism() - 1,
    Math.floor(totalmem() / WORKER_MEMORY_BUDGET_BYTES),
  ),
);

export default defineConfig({
  resolve: {
    alias: {
      "@": srcPath,
      "server-only": serverOnlyStubPath,
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/vitest.setup.ts"],

    maxWorkers,

    server: {
      deps: {
        // `next-intl/middleware` ships ESM that imports the extensionless
        // `next/server` subpath. Transforming the package through Vite lets its
        // imports resolve through the `next` package exports map.
        inline: ["next-intl"],
      },
    },

    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "src/**/*.unit.test.{ts,tsx}",
            "tests/*.unit.test.{ts,tsx}",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.integration.test.{ts,tsx}"],
          // These suites share one database, and some of them reason about a
          // global invariant — the number of administrators the last-administrator
          // policy protects. Two files creating administrators at the same time
          // make that count non-deterministic, so integration files run one at a
          // time and each cleans up the rows it created.
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "contract",
          include: ["tests/contract/**/*.contract.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["tests/ui/**/*.ui.test.{ts,tsx}"],
          setupFiles: ["./tests/vitest.setup.ts", "./tests/ui/vitest.setup.ts"],
        },
      },
    ],

    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",

      include: ["src/**/*.{ts,tsx}"],

      exclude: [
        "src/app/**",
        "src/proxy.ts",
        // Process entry points, for the same reason as `src/proxy.ts`: they own
        // signal handlers, an exit code, and a Prisma disconnect, none of which
        // a unit test can exercise without becoming the process. What they
        // delegate to is covered.
        "src/worker/jobs.*.ts",
        "src/i18n/navigation.ts",
        "src/i18n/request.ts",
        "src/i18n/routing.ts",
        "src/generated/prisma/**",
        "src/**/*.d.ts",
        "src/**/*.{test,spec}.{ts,tsx}",
        "src/**/index.client.ts",
        "src/**/index.server.ts",
      ],

      thresholds: {
        statements: 85,
        branches: 80,

        "src/modules/**/domain/**": {
          statements: 95,
        },

        "src/modules/**/application/**": {
          statements: 90,
        },
      },
    },
  },
});
