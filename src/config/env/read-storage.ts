import { parseEnvironment } from "./parse";
import { storageEnvironmentSchema, type StorageEnvironment } from "./schema";

/**
 * The variables this reader looks up, named for documentation. The index
 * signature is what lets `process.env` be passed directly: none of these names
 * is declared on `ProcessEnv`, so a purely optional shape would be rejected as
 * having nothing in common with it.
 */
type StorageEnvironmentSource = Readonly<Record<string, string | undefined>> & {
  readonly STORAGE_ENABLED?: string;
  readonly STORAGE_ENDPOINT?: string;
  readonly STORAGE_REGION?: string;
  readonly STORAGE_BUCKET?: string;
  readonly STORAGE_ACCESS_KEY_ID?: string;
  readonly STORAGE_SECRET_ACCESS_KEY?: string;
  readonly STORAGE_SESSION_TOKEN?: string;
  readonly STORAGE_FORCE_PATH_STYLE?: string;
  readonly STORAGE_KEY_PREFIX?: string;
  readonly STORAGE_CONNECT_TIMEOUT_MS?: string;
  readonly STORAGE_REQUEST_TIMEOUT_MS?: string;
  readonly STORAGE_UPLOAD_URL_TTL_SECONDS?: string;
  readonly STORAGE_DOWNLOAD_URL_TTL_SECONDS?: string;
  readonly STORAGE_UPLOAD_INTENT_TTL_SECONDS?: string;
  readonly STORAGE_FINALIZE_LEASE_MS?: string;
  readonly STORAGE_MAX_UPLOAD_BYTES?: string;
  readonly STORAGE_TEST_RUN_ID?: string;
};

/**
 * The names this reader copies out of the source, and the only ones the storage
 * schema will accept — it is `.strict()`, so an unrelated variable that reached
 * it would be an error rather than an ignored extra.
 *
 * Listing them once and picking with a loop keeps the reader honest: a variable
 * added to the schema and forgotten here is a variable that silently never
 * arrives, and that is a bug an `undefined`-spreading chain hides well.
 */
const STORAGE_VARIABLES = [
  "STORAGE_ENABLED",
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_SESSION_TOKEN",
  "STORAGE_FORCE_PATH_STYLE",
  "STORAGE_KEY_PREFIX",
  "STORAGE_CONNECT_TIMEOUT_MS",
  "STORAGE_REQUEST_TIMEOUT_MS",
  "STORAGE_UPLOAD_URL_TTL_SECONDS",
  "STORAGE_DOWNLOAD_URL_TTL_SECONDS",
  "STORAGE_UPLOAD_INTENT_TTL_SECONDS",
  "STORAGE_FINALIZE_LEASE_MS",
  "STORAGE_MAX_UPLOAD_BYTES",
  "STORAGE_TEST_RUN_ID",
] as const;

/**
 * Reads the optional object storage configuration.
 *
 * Like the Redis and jobs readers, and unlike the server and database ones, this
 * is never called at import time. `index.server.ts` does not export a
 * `storageEnv`, because doing so would make a bucket part of startup validation
 * and a project that never uploads a file would still be paying for it. The
 * storage platform reads this lazily, on first use.
 *
 * A source with no storage variable at all is valid and yields a disabled
 * configuration. Notably, an *invalid* endpoint or an odd credential pair is
 * also not read while `STORAGE_ENABLED` is absent — the whole object is parsed,
 * but a disabled configuration requires nothing of the rest.
 */
export function readStorageEnvironment(
  source: StorageEnvironmentSource = process.env,
): StorageEnvironment {
  const values: Record<string, string> = {};

  for (const name of STORAGE_VARIABLES) {
    const value = source[name];

    if (value !== undefined) {
      values[name] = value;
    }
  }

  return parseEnvironment("storage", storageEnvironmentSchema, values);
}
