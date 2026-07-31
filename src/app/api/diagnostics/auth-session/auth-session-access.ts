import type { ServerEnvironment } from "@/config/env/schema";

function isAuthSessionDiagnosticEnabled(
  environment: ServerEnvironment["APP_ENV"],
) {
  return environment === "development" || environment === "test";
}

export { isAuthSessionDiagnosticEnabled };
