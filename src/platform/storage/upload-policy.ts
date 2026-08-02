/**
 * What an upload is allowed to be.
 *
 * A policy is a value, built by server-owned code and passed to the platform by
 * the call site. It is deliberately not a registry: there is no global table of
 * policies to look a name up in, and no call site ever passes a bare policy
 * name. That matters because a name looked up in a mutable table is a name a
 * request could eventually supply, and "which policy applies" would stop being
 * a decision the server made.
 *
 * The platform ships no policy of its own. It has no opinion about whether this
 * application accepts PDFs or images, how large a profile photograph may be, or
 * whether a document must be scanned — those belong to the module that owns the
 * feature. The only policies in this repository are the fixtures the tests
 * build.
 */
import { ValidationError } from "@/shared/errors/application-error";

/**
 * Whether the upload must be looked at by a content inspector.
 *
 * `optional` means the platform will use an inspector if one is supplied and
 * record `not-configured` if not — the file is finalized either way, and it is
 * never described as safe. `required` means the finalization *fails* without an
 * inspector, closed rather than open, which is the only useful meaning of the
 * word for something that exists to catch hostile content.
 */
export const UPLOAD_INSPECTION = {
  OPTIONAL: "optional",
  REQUIRED: "required",
} as const;

export type UploadInspection =
  (typeof UPLOAD_INSPECTION)[keyof typeof UPLOAD_INSPECTION];

export type AllowedUploadFile = Readonly<{
  /** One exact media type. Never a wildcard. */
  contentType: string;
  /** Lowercase, no leading dot. At least one. */
  extensions: readonly string[];
}>;

export type UploadPolicyDefinition = Readonly<{
  name: string;
  allowedFiles: readonly AllowedUploadFile[];
  maxBytes: number;
  inspection?: UploadInspection;
}>;

export type UploadPolicy = Readonly<{
  name: string;
  allowedFiles: readonly AllowedUploadFile[];
  maxBytes: number;
  inspection: UploadInspection;
  /** The extensions this policy accepts for one media type, or none. */
  extensionsFor: (contentType: string) => readonly string[];
}>;

/**
 * `<owner>.<purpose>`: two lowercase segments, hyphens allowed inside one.
 *
 * Short enough to read in a database row, structured enough that two modules
 * cannot collide by accident, and closed enough that it can be constrained by
 * the column it is stored in.
 */
const POLICY_NAME_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
export const MAX_POLICY_NAME_LENGTH = 64;

/**
 * An exact media type, and only an exact one.
 *
 * `image/*` is refused on purpose. A wildcard is how an allowlist quietly
 * becomes a denylist: `image/*` admits `image/svg+xml`, which is a document
 * that executes script in the browser that opens it.
 */
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
export const MAX_CONTENT_TYPE_LENGTH = 128;

const EXTENSION_PATTERN = /^[a-z0-9]{1,16}$/;

export function isValidUploadPolicyName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_POLICY_NAME_LENGTH &&
    POLICY_NAME_PATTERN.test(value)
  );
}

export function isValidUploadContentType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_CONTENT_TYPE_LENGTH &&
    CONTENT_TYPE_PATTERN.test(value)
  );
}

export function isValidUploadExtension(value: unknown): value is string {
  return typeof value === "string" && EXTENSION_PATTERN.test(value);
}

/**
 * Builds one policy, validating it eagerly.
 *
 * Eagerly, because a policy is defined by module-level code: a mistake in one
 * fails the import that declares it rather than the first upload that uses it,
 * which turns a production incident into a failed build.
 *
 * `globalMaxBytes` is the deployment-wide ceiling. It is passed in rather than
 * read here so that defining a policy stays a pure operation with no dependency
 * on the environment — a policy can be declared, and unit-tested, on a machine
 * that has no storage configured at all.
 */
export function defineUploadPolicy(
  definition: UploadPolicyDefinition,
  globalMaxBytes = Number.POSITIVE_INFINITY,
): UploadPolicy {
  if (!isValidUploadPolicyName(definition.name)) {
    throw new ValidationError(
      "An upload policy name must be <owner>.<purpose> in lowercase.",
    );
  }

  if (definition.allowedFiles.length === 0) {
    throw new ValidationError(
      "An upload policy must allow at least one media type.",
    );
  }

  if (
    !Number.isSafeInteger(definition.maxBytes) ||
    definition.maxBytes <= 0 ||
    definition.maxBytes > globalMaxBytes
  ) {
    throw new ValidationError(
      "An upload policy size limit must be a positive integer within the deployment maximum.",
    );
  }

  const byContentType = new Map<string, readonly string[]>();
  const seenExtensions = new Set<string>();

  for (const allowed of definition.allowedFiles) {
    if (!isValidUploadContentType(allowed.contentType)) {
      throw new ValidationError(
        "An upload policy must name exact media types, never a wildcard.",
      );
    }

    if (byContentType.has(allowed.contentType)) {
      throw new ValidationError(
        "An upload policy must declare each media type once.",
      );
    }

    if (allowed.extensions.length === 0) {
      throw new ValidationError(
        "Every media type in an upload policy must declare its extensions.",
      );
    }

    for (const extension of allowed.extensions) {
      if (!isValidUploadExtension(extension)) {
        throw new ValidationError(
          "An upload policy extension must be lowercase and carry no dot.",
        );
      }

      // Across the whole policy, not only within one media type. Two media
      // types claiming `pdf` would make "which type is this extension" a
      // question with two answers, and the check at declaration time is what
      // stops that from being decided by iteration order at upload time.
      if (seenExtensions.has(extension)) {
        throw new ValidationError(
          "An upload policy must declare each extension once.",
        );
      }

      seenExtensions.add(extension);
    }

    byContentType.set(allowed.contentType, [...allowed.extensions]);
  }

  const allowedFiles = definition.allowedFiles.map((allowed) => ({
    contentType: allowed.contentType,
    extensions: [...allowed.extensions] as readonly string[],
  }));

  return Object.freeze({
    name: definition.name,
    allowedFiles: Object.freeze(allowedFiles),
    maxBytes: definition.maxBytes,
    inspection: definition.inspection ?? UPLOAD_INSPECTION.OPTIONAL,
    extensionsFor: (contentType: string) =>
      byContentType.get(contentType) ?? [],
  });
}
