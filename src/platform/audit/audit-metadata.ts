/**
 * The metadata policy for an audit record.
 *
 * Metadata is the one open-ended field an audit record has, which makes it the
 * one field that can leak. Every other column is an identifier, a stable name,
 * or a closed enum; this one holds whatever the action decided was worth
 * remembering, it is durable, and it is rendered to an administrator. So the
 * policy is defence in depth rather than a single check:
 *
 * 1. Each action declares a closed `.strict()` schema, so only the keys that
 *    action named can ever be stored.
 * 2. The value must be JSON, in the narrow sense: plain objects, arrays,
 *    strings, finite numbers, booleans, and `null`. A `Date`, a `Map`, a
 *    `Buffer`, an `Error`, or a class instance is refused rather than coerced,
 *    because coercion is how a stack trace becomes a string.
 * 3. A recursive, case-insensitive scan refuses a key whose name is one of the
 *    known-dangerous ones, at any depth.
 * 4. The serialized value is bounded.
 *
 * None of that detects personal data in general. A field called `note` can hold
 * an email address and no automated check will know. The defences narrow the
 * accident surface; the closed schemas and code review are what actually decide
 * what is recorded, and the architecture document says so explicitly.
 */
export type AuditMetadata = Readonly<Record<string, unknown>>;

/** The serialized ceiling, mirrored by a database constraint. */
export const MAX_AUDIT_METADATA_BYTES = 4096;

/**
 * Key names that must never appear in metadata, at any depth.
 *
 * Comparison is case-insensitive, so `Authorization`, `authorization`, and
 * `AUTHORIZATION` are all refused. The list is not a definition of personal
 * data; it is the set of names that have a specific, known meaning in this
 * application and would be a disclosure if stored.
 */
export const FORBIDDEN_AUDIT_METADATA_KEYS = [
  "password",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "cookie",
  "cookies",
  "authorization",
  "secret",
  "clientsecret",
  "apikey",
  "email",
  "displayname",
  "fullname",
  "ipaddress",
  "useragent",
  "headers",
  "request",
  "requestbody",
  "responsebody",
  "body",
  "error",
  "stack",
] as const;

const forbiddenKeys = new Set<string>(FORBIDDEN_AUDIT_METADATA_KEYS);

export const AUDIT_METADATA_REJECTION = {
  /** Not a plain JSON structure, or self-referential. */
  NOT_JSON: "not-json",
  /** A key name the policy refuses appears somewhere in the structure. */
  FORBIDDEN_KEY: "forbidden-key",
  /** Serializes to more than the ceiling allows. */
  TOO_LARGE: "too-large",
} as const;

export type AuditMetadataRejection =
  (typeof AUDIT_METADATA_REJECTION)[keyof typeof AUDIT_METADATA_REJECTION];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  // A `Map`, a `Set`, a `Date`, a `Buffer`, an `Error`, and any class instance
  // all fail here. Only an object literal and a null-prototype object pass, and
  // those are the only two shapes `JSON.parse` ever produces.
  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * Whether a value is JSON in the sense this platform means.
 *
 * Stricter than "survives `JSON.stringify`". `undefined`, a function, and a
 * symbol survive it by disappearing; `NaN` and `Infinity` survive it by becoming
 * `null`; a `Date` survives it by becoming a string that no longer parses back
 * to a `Date`. All four are silent changes to a durable record, so all four are
 * refused here instead.
 */
export function isAuditJsonValue(value: unknown): boolean {
  return isJsonValue(value, new WeakSet<object>());
}

function isJsonValue(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value !== "object") {
    // `undefined`, `bigint`, `function`, and `symbol`.
    return false;
  }

  if (seen.has(value)) {
    // A cycle. `JSON.stringify` throws on one; refusing it here means the
    // caller gets a validation failure rather than an exception.
    return false;
  }

  seen.add(value);

  const children = Array.isArray(value)
    ? value
    : isPlainObject(value)
      ? Object.values(value)
      : null;

  if (children === null) {
    return false;
  }

  const acceptable = children.every((child) => isJsonValue(child, seen));

  seen.delete(value);

  return acceptable;
}

function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasForbiddenKey(entry));
  }

  if (!isPlainObject(value)) {
    return false;
  }

  return Object.entries(value).some(
    ([key, entry]) =>
      forbiddenKeys.has(key.toLowerCase()) || hasForbiddenKey(entry),
  );
}

/** The serialized size the database constraint measures. */
export function auditMetadataByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/**
 * Applies the whole policy to one candidate value.
 *
 * `null` means acceptable. Anything else is the reason, so a caller can turn it
 * into a message without re-deriving why.
 *
 * The top level must be an object. An audit record's metadata describes the
 * action with named fields; a bare string or array would be a value with no
 * stated meaning, and there would be nothing for a `.strict()` schema to close.
 */
export function checkAuditMetadata(
  value: unknown,
): AuditMetadataRejection | null {
  if (!isPlainObject(value) || !isAuditJsonValue(value)) {
    return AUDIT_METADATA_REJECTION.NOT_JSON;
  }

  if (hasForbiddenKey(value)) {
    return AUDIT_METADATA_REJECTION.FORBIDDEN_KEY;
  }

  return auditMetadataByteLength(value) > MAX_AUDIT_METADATA_BYTES
    ? AUDIT_METADATA_REJECTION.TOO_LARGE
    : null;
}

/**
 * Narrows a value that has already passed the policy.
 *
 * Used where a stored value is read back: the shape is re-checked before a
 * reader is allowed to see it, because what was written may predate the schema
 * that is reading it.
 */
export function asAuditMetadata(value: unknown): AuditMetadata | null {
  return checkAuditMetadata(value) === null ? (value as AuditMetadata) : null;
}
