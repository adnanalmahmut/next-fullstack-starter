import { parseEnvironment } from "./parse";
import {
  errorMonitoringEnvironmentSchema,
  type ErrorMonitoringEnvironment,
} from "./schema";

/**
 * The variables this reader looks up, named for documentation. The index
 * signature is what lets `process.env` be passed directly: none of these names
 * is declared on `ProcessEnv`, so a purely optional shape would be rejected as
 * having nothing in common with it.
 */
type ErrorMonitoringEnvironmentSource = Readonly<
  Record<string, string | undefined>
> & {
  readonly ERROR_MONITORING_ENABLED?: string;
  readonly SENTRY_DSN?: string;
  readonly APP_RELEASE?: string;
};

const ERROR_MONITORING_ENABLED_VARIABLE_NAMES = [
  "SENTRY_DSN",
  "APP_RELEASE",
] as const;

/**
 * Reads the optional error-monitoring configuration.
 *
 * It is a separate reader from the telemetry one, and separate for the reason the
 * two schemas are separate: traces go to a collector, unexpected failures go to a
 * vendor, and neither decision may switch the other off. A project can delete
 * one of the two directories without editing the other's configuration.
 *
 * The disabled path reads **only** `ERROR_MONITORING_ENABLED`. `SENTRY_DSN` is a
 * credential, and an application that is not reporting errors anywhere must not
 * hold one, echo it in a validation error, or refuse to boot because of one. A
 * unit test passes a recording source and asserts the DSN was never looked at.
 */
export function readErrorMonitoringEnvironment(
  source: ErrorMonitoringEnvironmentSource = process.env,
): ErrorMonitoringEnvironment {
  const enabled = source.ERROR_MONITORING_ENABLED;

  if (enabled !== "true") {
    return parseEnvironment(
      "error monitoring",
      errorMonitoringEnvironmentSchema,
      enabled === undefined ? {} : { ERROR_MONITORING_ENABLED: enabled },
    );
  }

  const values: Record<string, string> = {
    ERROR_MONITORING_ENABLED: enabled,
  };

  for (const name of ERROR_MONITORING_ENABLED_VARIABLE_NAMES) {
    const value = source[name];

    if (value !== undefined) {
      values[name] = value;
    }
  }

  return parseEnvironment(
    "error monitoring",
    errorMonitoringEnvironmentSchema,
    values,
  );
}
