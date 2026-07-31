import type { ServerEnvironment } from "@/config/env/schema";

function isRequestContextDiagnosticEnabled(
  environment: ServerEnvironment["APP_ENV"],
) {
  return environment === "development" || environment === "test";
}

export { isRequestContextDiagnosticEnabled };
