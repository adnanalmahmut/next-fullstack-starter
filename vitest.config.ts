import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": srcPath,
    },
  },
  test: {
    environment: "node",

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
        },
      },
      {
        extends: true,
        test: {
          name: "contract",
          include: ["tests/contract/**/*.contract.test.{ts,tsx}"],
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
