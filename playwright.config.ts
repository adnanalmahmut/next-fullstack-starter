import { defineConfig } from "@playwright/test";

import { TEST_ONLY_BETTER_AUTH_SECRET } from "./tests/test-secrets";

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

const webServerCommand = process.env.CI
  ? `pnpm start --hostname 127.0.0.1 --port ${port}`
  : `pnpm dev --hostname 127.0.0.1 --port ${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.spec.ts",

  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],

  webServer: {
    command: webServerCommand,
    url: baseURL,
    env: {
      ...process.env,
      APP_ENV: "test",
      NEXT_PUBLIC_APP_URL: baseURL,
      // The application never falls back to a secret; the test server is
      // given a test-only value here.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? TEST_ONLY_BETTER_AUTH_SECRET,
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },

  outputDir: "test-results",
});
