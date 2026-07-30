import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { registerObservability } =
    await import("./platform/observability/register-observability.server");

  registerObservability();
}

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { reportRequestErrorSafely } =
    await import("./platform/observability/request-error-reporter.server");

  reportRequestErrorSafely(error, request, context);
};
