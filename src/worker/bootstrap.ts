import { loadEnvConfig } from "@next/env";

/**
 * What a worker process has to do before it can import anything.
 *
 * A worker is not started by Next.js, so nothing has loaded `.env*` and nothing
 * has set `NODE_ENV`. Both matter before the first import of application code,
 * because `@/config/env/index.server` validates the server environment at module
 * evaluation — by design, so a misconfigured deployment fails at startup rather
 * than on its first request. That is why every entry point here calls this
 * first and reaches the rest of the application through `await import(...)`.
 *
 * `NODE_ENV` is derived from `APP_ENV` rather than defaulted to a guess. The
 * application already treats `APP_ENV` as the authoritative answer to "which
 * environment is this", so taking `NODE_ENV` from it keeps one source of truth,
 * needs no `NODE_ENV=…` prefix in a package script, and behaves the same on
 * Windows as on Linux. An explicitly set `NODE_ENV` always wins.
 */
const NODE_ENV_BY_APP_ENV = {
  development: "development",
  test: "test",
  staging: "production",
  production: "production",
} as const;

export function loadWorkerEnvironment(): void {
  loadEnvConfig(process.cwd());

  if (process.env.NODE_ENV !== undefined) {
    return;
  }

  const appEnvironment = process.env.APP_ENV;

  // `NODE_ENV` is typed read-only, because inside the application it is set by
  // the bundler and changing it mid-process would be a bug. Here it has not been
  // set by anything yet: this is the one moment before the first application
  // import, in a process the bundler never touched.
  const environment = process.env as Record<string, string | undefined>;

  environment.NODE_ENV =
    appEnvironment !== undefined && appEnvironment in NODE_ENV_BY_APP_ENV
      ? NODE_ENV_BY_APP_ENV[appEnvironment as keyof typeof NODE_ENV_BY_APP_ENV]
      : "production";
}

/**
 * The exit codes a jobs entry point uses.
 *
 * `MISCONFIGURED` is separate from `FAILED` so a supervisor can tell "this will
 * never start until someone changes a variable" from "this crashed and may come
 * back", and stop restarting the first one in a tight loop.
 */
export const WORKER_EXIT_CODE = {
  OK: 0,
  FAILED: 1,
  MISCONFIGURED: 78,
} as const;
