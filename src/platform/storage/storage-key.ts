import { randomBytes } from "node:crypto";

/**
 * The layout of every key this platform writes.
 *
 * A key is generated server-side, from strong randomness, and carries no
 * information at all. Not the original filename, not a user identifier, not an
 * email address, not a business identifier, not a content type. That is
 * deliberate and it is not paranoia: object keys appear in provider access logs,
 * in bucket listings, in billing exports, and in support conversations, and
 * every one of those is a place a filename like
 * `medical-report-2026-ahmad.pdf` should never reach.
 *
 * The layout is:
 *
 *     <prefix>/<environment>/<namespace>/<random>
 *     <prefix>/<environment>/<test-run>/<namespace>/<random>
 *
 * The test-run segment exists only under `APP_ENV=test`, and it is what lets two
 * suites — or two CI runs — share one bucket without seeing each other's
 * objects, and lets a suite clean up by prefix without the possibility of
 * deleting something it did not create.
 *
 * The three namespaces are not decoration. `staging` is the only one a client
 * can ever write to, `objects` is the only one a finalized object lives in, and
 * `quarantine` holds what an inspector withheld. Keeping them apart is what
 * makes "the client cannot touch the final object" a property of the key space
 * rather than a rule someone has to remember.
 */
export const STORAGE_NAMESPACE = {
  STAGING: "staging",
  OBJECTS: "objects",
  QUARANTINE: "quarantine",
} as const;

export type StorageNamespace =
  (typeof STORAGE_NAMESPACE)[keyof typeof STORAGE_NAMESPACE];

export const STORAGE_NAMESPACES = Object.values(
  STORAGE_NAMESPACE,
) as readonly StorageNamespace[];

export const STORAGE_KEY_SEPARATOR = "/";
export const MAX_STORAGE_KEY_LENGTH = 512;
export const MIN_STORAGE_KEY_LENGTH = 8;

/**
 * 24 random bytes, hex-encoded to 48 characters.
 *
 * 192 bits, which is far more than guessing resistance needs — but a staging key
 * is visible to the client that receives the presigned form, and a final key
 * must not be derivable from it, so there is no reason to be frugal here.
 *
 * Hex rather than the shorter base64url on purpose. Base64url's alphabet
 * includes `-` and `_`, so roughly one key in thirty would begin with one of
 * them and fail the segment grammar below — a defect that appears at random,
 * in production, long after the tests that happened not to generate one.
 */
const KEY_RANDOM_BYTES = 24;

export type StorageKeyScope = Readonly<{
  prefix: string;
  environment: string;
  testRunId?: string;
}>;

/**
 * A key segment: no separator, no traversal, no whitespace, no empty value.
 *
 * Uppercase is allowed because a configured prefix may carry it; a dot is
 * allowed so a prefix like `acme.co` works, but two dots never are. The segment
 * must begin with an alphanumeric, which is what a leading `-` or `_` would
 * otherwise slip past on its way into a provider request.
 */
const KEY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidStorageKeySegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    KEY_SEGMENT_PATTERN.test(value) &&
    !value.includes("..")
  );
}

/**
 * The whole-key shape, restated independently of how the key was built.
 *
 * Every key this platform produces satisfies it by construction. It is checked
 * anyway before a provider call, because the cost is a regular expression and
 * the thing being prevented is addressing an object the application did not
 * intend to.
 */
export function isValidStorageKey(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < MIN_STORAGE_KEY_LENGTH ||
    value.length > MAX_STORAGE_KEY_LENGTH
  ) {
    return false;
  }

  if (
    value.includes("..") ||
    value.includes("//") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    return false;
  }

  return value
    .split(STORAGE_KEY_SEPARATOR)
    .every((segment) => isValidStorageKeySegment(segment));
}

export function assertValidStorageKey(value: string): string {
  if (!isValidStorageKey(value)) {
    throw new Error("The storage key is not a well-formed key.");
  }

  return value;
}

/** The prefix every key of one namespace shares, including its trailing slash. */
export function storageNamespacePrefix(
  scope: StorageKeyScope,
  namespace: StorageNamespace,
): string {
  const segments = [
    scope.prefix,
    scope.environment,
    ...(scope.testRunId === undefined ? [] : [scope.testRunId]),
    namespace,
  ];

  for (const segment of segments) {
    if (!isValidStorageKeySegment(segment)) {
      throw new Error("The storage key scope contains an unusable segment.");
    }
  }

  return `${segments.join(STORAGE_KEY_SEPARATOR)}${STORAGE_KEY_SEPARATOR}`;
}

/**
 * The prefix that covers everything this process may write.
 *
 * A test suite deletes under this and nothing wider, which is what keeps a
 * cleanup from reaching another run's objects — or, on a shared bucket, another
 * application's.
 */
export function storageScopePrefix(scope: StorageKeyScope): string {
  const segments = [
    scope.prefix,
    scope.environment,
    ...(scope.testRunId === undefined ? [] : [scope.testRunId]),
  ];

  for (const segment of segments) {
    if (!isValidStorageKeySegment(segment)) {
      throw new Error("The storage key scope contains an unusable segment.");
    }
  }

  return `${segments.join(STORAGE_KEY_SEPARATOR)}${STORAGE_KEY_SEPARATOR}`;
}

function randomKeySegment(): string {
  return randomBytes(KEY_RANDOM_BYTES).toString("hex");
}

/**
 * A fresh key in one namespace.
 *
 * The random part is generated here and nowhere else, and it is generated
 * independently for staging and for the final object: deriving one from the
 * other would hand the client — which sees the staging key in its upload form —
 * the address of an object it must never be able to name.
 */
export function buildStorageKey(
  scope: StorageKeyScope,
  namespace: StorageNamespace,
): string {
  return assertValidStorageKey(
    `${storageNamespacePrefix(scope, namespace)}${randomKeySegment()}`,
  );
}

export function isStorageKeyInNamespace(
  key: string,
  namespace: StorageNamespace,
): boolean {
  return key.includes(
    `${STORAGE_KEY_SEPARATOR}${namespace}${STORAGE_KEY_SEPARATOR}`,
  );
}
