import type { ServerEnvironment } from "@/config/env/schema";

type AppEnvironment = ServerEnvironment["APP_ENV"];

/**
 * Email sign-up exists so development and automated tests can provision
 * accounts through Better Auth itself instead of writing password hashes by
 * hand. It is not a product feature: no registration page or link exists, and
 * deployed environments reject the endpoint server-side.
 */
export function isEmailRegistrationEnabled(
  appEnvironment: AppEnvironment,
): boolean {
  return appEnvironment === "development" || appEnvironment === "test";
}

export type { AppEnvironment };
