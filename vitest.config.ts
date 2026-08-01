import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStubPath = fileURLToPath(
  new URL("./tests/server-only.stub.ts", import.meta.url),
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
