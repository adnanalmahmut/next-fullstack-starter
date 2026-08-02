import { timingSafeEqual } from "node:crypto";

/**
 * The one canonical form of a SHA-256 digest in this platform: 64 lowercase
 * hexadecimal characters.
 *
 * Having exactly one representation is a security property rather than a style
 * choice. S3 wants the digest base64-encoded in a header, a client naturally
 * produces hex, and PostgreSQL stores whatever it is given; three
 * representations would mean three ways for a comparison to be defeated by an
 * encoding difference. So the platform speaks hex everywhere, the database
 * constrains the column to hex, and the conversion to base64 happens in one
 * place — inside the provider adapter, at the moment the header is built.
 */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const SHA256_HEX_LENGTH = 64;
export const SHA256_BYTE_LENGTH = 32;

export function isCanonicalSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

/**
 * Uppercase hex is rejected rather than lowercased.
 *
 * A declaration arrives from a client, and normalizing it would mean the value
 * stored is not the value sent. Refusing keeps "what the client declared" and
 * "what the database holds" the same string, which is what makes a later
 * mismatch mean something.
 */
export function assertCanonicalSha256Hex(value: unknown): string {
  if (!isCanonicalSha256Hex(value)) {
    throw new Error(
      "A SHA-256 checksum must be 64 lowercase hexadecimal characters.",
    );
  }

  return value;
}

/** Hex to the base64 form S3 expects in `x-amz-checksum-sha256`. */
export function sha256HexToBase64(hex: string): string {
  return Buffer.from(assertCanonicalSha256Hex(hex), "hex").toString("base64");
}

/**
 * Base64 back to canonical hex, or `null` when the value is not a SHA-256
 * digest at all.
 *
 * `null` rather than a throw: the input is a provider response header, and a
 * provider that answers with a checksum algorithm this platform did not ask for
 * is a case to fall back from, not a crash.
 */
export function sha256Base64ToHex(value: string): string | null {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    return null;
  }

  const bytes = Buffer.from(value, "base64");

  if (bytes.byteLength !== SHA256_BYTE_LENGTH) {
    return null;
  }

  return bytes.toString("hex");
}

/**
 * Constant-time comparison of two canonical digests.
 *
 * A checksum is not a secret, so this is defence in depth rather than a
 * strict requirement. It costs nothing, and it removes the need to reason about
 * whether a timing signal on "how many leading bytes matched" could ever be
 * combined with something else — which is exactly the reasoning that tends to
 * be wrong.
 *
 * A malformed input compares as unequal instead of throwing: both sides are
 * validated where they enter, and a length check that threw here would leak the
 * same information the constant-time comparison is avoiding.
 */
export function sha256HexEquals(left: string, right: string): boolean {
  if (!isCanonicalSha256Hex(left) || !isCanonicalSha256Hex(right)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
