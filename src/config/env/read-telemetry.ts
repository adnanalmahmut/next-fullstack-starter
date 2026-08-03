import { parseEnvironment } from "./parse";
import {
  telemetryEnvironmentSchema,
  type TelemetryEnvironment,
} from "./schema";

/**
 * The variables this reader looks up, named for documentation. The index
 * signature is what lets `process.env` be passed directly: none of these names
 * is declared on `ProcessEnv`, so a purely optional shape would be rejected as
 * having nothing in common with it.
 */
type TelemetryEnvironmentSource = Readonly<
  Record<string, string | undefined>
> & {
  readonly TELEMETRY_ENABLED?: string;
  readonly TELEMETRY_OTLP_ENDPOINT?: string;
  readonly TELEMETRY_OTLP_HEADERS?: string;
  readonly TELEMETRY_TRACE_SAMPLE_RATIO?: string;
  readonly TELEMETRY_METRIC_EXPORT_INTERVAL_MS?: string;
  readonly TELEMETRY_EXPORT_TIMEOUT_MS?: string;
  readonly APP_RELEASE?: string;
};

/**
 * The variables that only mean something once telemetry is on.
 *
 * They are listed apart from `TELEMETRY_ENABLED` because the disabled reader must
 * not touch them at all — see below.
 */
const TELEMETRY_ENABLED_VARIABLE_NAMES = [
  "TELEMETRY_OTLP_ENDPOINT",
  "TELEMETRY_OTLP_HEADERS",
  "TELEMETRY_TRACE_SAMPLE_RATIO",
  "TELEMETRY_METRIC_EXPORT_INTERVAL_MS",
  "TELEMETRY_EXPORT_TIMEOUT_MS",
  "APP_RELEASE",
] as const;

/**
 * Reads the optional telemetry configuration.
 *
 * Like the Redis, jobs, and storage readers, this one is never called at import
 * time. `index.server.ts` exports no `telemetryEnv`, because doing so would make
 * a collector part of startup validation and a project that never enables
 * telemetry would still be paying for it.
 *
 * The disabled path deliberately reads **only** `TELEMETRY_ENABLED`. That is not
 * an optimization: `TELEMETRY_OTLP_HEADERS` is a credential, and a disabled
 * application has no business holding one in memory, printing it in a validation
 * error, or failing to boot because the operator left a malformed one behind. A
 * unit test passes a recording source and asserts the sensitive names were never
 * looked at.
 *
 * A source with no telemetry variable at all is valid and yields a disabled
 * configuration. An absent variable is omitted rather than passed as `undefined`,
 * so a schema default applies instead of being overwritten.
 */
export function readTelemetryEnvironment(
  source: TelemetryEnvironmentSource = process.env,
): TelemetryEnvironment {
  const enabled = source.TELEMETRY_ENABLED;

  if (enabled !== "true") {
    // A value that is neither `true` nor absent still has to be rejected, so it
    // is handed to the schema rather than treated as "off".
    return parseEnvironment(
      "telemetry",
      telemetryEnvironmentSchema,
      enabled === undefined ? {} : { TELEMETRY_ENABLED: enabled },
    );
  }

  const values: Record<string, string> = { TELEMETRY_ENABLED: enabled };

  for (const name of TELEMETRY_ENABLED_VARIABLE_NAMES) {
    const value = source[name];

    if (value !== undefined) {
      values[name] = value;
    }
  }

  return parseEnvironment("telemetry", telemetryEnvironmentSchema, values);
}
