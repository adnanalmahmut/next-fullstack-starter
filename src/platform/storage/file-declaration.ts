import { ValidationError } from "@/shared/errors/application-error";

import { assertCanonicalSha256Hex, isCanonicalSha256Hex } from "./checksum";
import {
  isValidUploadContentType,
  isValidUploadExtension,
  type UploadPolicy,
} from "./upload-policy";

/**
 * What the client says it is about to upload.
 *
 * This is the complete list. There is no filename, no path, no storage key, no
 * bucket, no ACL, no arbitrary metadata bag, and no identifier of any kind —
 * not a user, not a session, not a business resource. Everything absent from
 * this type is absent because it either belongs to the calling module (who is
 * uploading, and what for) or must never be accepted from a client at all
 * (where the bytes will live).
 *
 * A filename in particular is not merely unnecessary; accepting one would mean
 * storing client-controlled text that later wants to be rendered, logged, and
 * put in a header. The platform generates its own key and lets the caller
 * choose a download name at download time, which is a much smaller surface.
 *
 * Every value here is a *claim*. `contentType` and `extension` are what the
 * browser guessed; neither proves anything about the bytes. `sizeBytes` and
 * `checksumSha256` are checked against what actually arrived, which is what
 * makes them worth collecting: they turn "the client said" into something
 * falsifiable.
 */
export type UploadFileDeclaration = Readonly<{
  contentType: string;
  extension: string;
  sizeBytes: number;
  /** 64 lowercase hexadecimal characters. */
  checksumSha256: string;
}>;

export type ValidatedUploadFileDeclaration = Readonly<{
  contentType: string;
  extension: string;
  sizeBytes: number;
  checksumSha256: string;
}>;

/**
 * Validates a declaration against one policy and the deployment ceiling.
 *
 * The extension is checked against the set declared for *that* media type, not
 * against the union of the policy's extensions. A policy that allows PDFs and
 * PNGs must not accept `application/pdf` named `png`: the pair is what a client
 * would have to get right, and letting the two be mixed would make the
 * extension list decorative.
 *
 * None of this proves the bytes are what they claim to be, and the platform does
 * not pretend otherwise. A file whose first bytes are a Windows executable can
 * be declared as `application/pdf` with a `pdf` extension and a correct
 * SHA-256, and every check here will pass. Deciding what the content *is*
 * requires reading it, which is what `StorageContentInspector` is for.
 */
export function validateUploadFileDeclaration(
  declaration: UploadFileDeclaration,
  policy: UploadPolicy,
  globalMaxBytes: number,
): ValidatedUploadFileDeclaration {
  if (!isValidUploadContentType(declaration.contentType)) {
    throw new ValidationError("The declared media type is not a media type.");
  }

  if (!isValidUploadExtension(declaration.extension)) {
    throw new ValidationError(
      "The declared file extension must be lowercase and carry no dot.",
    );
  }

  if (!isCanonicalSha256Hex(declaration.checksumSha256)) {
    throw new ValidationError(
      "The declared checksum must be 64 lowercase hexadecimal characters.",
    );
  }

  if (
    !Number.isSafeInteger(declaration.sizeBytes) ||
    declaration.sizeBytes <= 0
  ) {
    throw new ValidationError("The declared size must be a positive integer.");
  }

  if (declaration.sizeBytes > policy.maxBytes) {
    throw new ValidationError(
      "The declared size exceeds the limit this upload policy allows.",
    );
  }

  if (declaration.sizeBytes > globalMaxBytes) {
    throw new ValidationError(
      "The declared size exceeds the deployment upload limit.",
    );
  }

  const extensions = policy.extensionsFor(declaration.contentType);

  if (extensions.length === 0) {
    throw new ValidationError(
      "This upload policy does not accept the declared media type.",
    );
  }

  if (!extensions.includes(declaration.extension)) {
    throw new ValidationError(
      "The declared extension does not belong to the declared media type.",
    );
  }

  return {
    contentType: declaration.contentType,
    extension: declaration.extension,
    sizeBytes: declaration.sizeBytes,
    checksumSha256: assertCanonicalSha256Hex(declaration.checksumSha256),
  };
}
