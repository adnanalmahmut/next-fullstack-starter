import type { Instrumentation } from "next";

/**
 * The one place Next.js runs code before the server is ready.
 *
 * It stays small and loads the Node-only implementation dynamically, so nothing
 * server-only — Pino, `AsyncLocalStorage`, or any telemetry SDK — can enter an
 * Edge bundle. The Edge runtime returns immediately: this application has no edge
 * telemetry and no client telemetry, by decision rather than by omission.
 *
 * The registration is awaited. Next.js guarantees `register` completes before the
 * first request is served, which is the only moment at which trace and metric
 * providers can be installed without the first request being silently untraced.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { registerObservability } =
    await import("./platform/observability/register-observability.server");

  await registerObservability();
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
