/**
 * The extension point for looking at what was actually uploaded.
 *
 * This platform verifies that the bytes match the declaration — the same size,
 * the same SHA-256, the media type the provider recorded. That is a real
 * guarantee and it is a narrow one: it proves the client uploaded the file it
 * said it would, and proves nothing whatsoever about whether that file is safe.
 * A ransomware executable declared as `application/pdf` passes every check this
 * platform makes.
 *
 * Closing that gap requires reading the content, and reading the content well
 * requires a scanner that is updated more often than an application is deployed.
 * So the platform defines the port and ships no implementation of it. A
 * deployment that needs scanning supplies one; the tests supply a fake.
 *
 * The port is intentionally not "an antivirus interface". It is "something that
 * looked at the object and reached one of two conclusions", which is equally the
 * shape of a magic-byte check, a document parser, an image decoder, or a
 * commercial scanning service.
 */
export const INSPECTION_OUTCOME = {
  CLEAN: "clean",
  QUARANTINE: "quarantine",
} as const;

export type InspectionOutcome =
  (typeof INSPECTION_OUTCOME)[keyof typeof INSPECTION_OUTCOME];

/**
 * What the inspector is told.
 *
 * A key and a size, and no more. Not the declared filename — there is none —
 * and not the user, the session, or the business resource, because an inspector
 * that knew who uploaded a file could reach a different conclusion for different
 * people, and that is not a decision a content scanner should be able to make.
 */
export type StorageInspectionRequest = Readonly<{
  objectId: string;
  /** The staging key. The object has not been promoted yet. */
  key: string;
  sizeBytes: number;
  declaredContentType: string;
}>;

export type StorageInspectionVerdict =
  | Readonly<{
      outcome: typeof INSPECTION_OUTCOME.CLEAN;
      /** What the inspector believes the content really is, if it can tell. */
      detectedContentType?: string;
    }>
  | Readonly<{
      outcome: typeof INSPECTION_OUTCOME.QUARANTINE;
      /**
       * A stable, bounded code from the inspector's own closed set — never a
       * scanner message and never a signature name. It is stored and may be
       * shown; a raw string from a third-party engine is neither of those
       * things safely.
       */
      reasonCode: string;
    }>;

export type StorageContentInspector = Readonly<{
  inspect: (
    request: StorageInspectionRequest,
  ) => Promise<StorageInspectionVerdict>;
}>;

export const MAX_INSPECTION_REASON_LENGTH = 64;

const INSPECTION_REASON_PATTERN = /^[a-z][a-z0-9-]*$/;

export function isValidInspectionReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_INSPECTION_REASON_LENGTH &&
    INSPECTION_REASON_PATTERN.test(value)
  );
}

/**
 * The code stored when an inspector quarantines an object.
 *
 * An inspector that answers with something outside the accepted shape is not
 * trusted to have produced a storable value, so the platform substitutes its own
 * code rather than writing whatever arrived into a column that is later
 * rendered.
 */
export const UNSPECIFIED_INSPECTION_REASON = "unspecified";

export function toStoredInspectionReason(value: unknown): string {
  return isValidInspectionReason(value) ? value : UNSPECIFIED_INSPECTION_REASON;
}
