/**
 * The OTLP header parser.
 *
 * `TELEMETRY_OTLP_HEADERS` is how a collector is authenticated, so its value is
 * a credential and is treated as one everywhere: it is parsed here, held in the
 * telemetry configuration, handed to the exporter, and never logged, never
 * serialized, and never returned in a validation error.
 *
 * The grammar is deliberately narrower than the W3C `baggage` form the
 * OpenTelemetry specification borrows for this variable. It is a comma-separated
 * list of `name=value` pairs, and it accepts nothing else — no quoting, no
 * escaping, no percent-decoding, no metadata after a semicolon. A parser that
 * decoded would be a parser that could be made to produce a byte the caller did
 * not write, and the only thing downstream of it is an HTTP request header.
 *
 * Four bounds hold, and each one closes a specific hole:
 *
 * - **No CR or LF, anywhere.** A newline in a header value is header injection:
 *   it ends the header and begins whatever the attacker wrote next.
 * - **A bounded count.** An unbounded list would let one environment variable
 *   grow an exporter request until the collector refused all of them.
 * - **A bounded name and value.** Same reason, per pair.
 * - **A closed name shape.** Only an RFC 7230 token, so a name can never carry
 *   a separator, a space, or a control character.
 */
export const MAX_OTLP_HEADERS = 8;
export const MAX_OTLP_HEADER_NAME_LENGTH = 64;
export const MAX_OTLP_HEADER_VALUE_LENGTH = 512;
export const MAX_OTLP_HEADERS_LENGTH = 2_048;

/** An RFC 7230 token: the characters a header name is actually allowed to use. */
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Printable US-ASCII, and nothing else.
 *
 * Space and tab are excluded rather than trimmed: a value that needed either
 * would need the quoting this parser refuses to implement, and accepting them
 * would make two visually identical configurations mean different things.
 */
const headerValuePattern = /^[!-~]+$/;

export type OtlpHeaders = Readonly<Record<string, string>>;

/**
 * Parses the variable, or answers `null`.
 *
 * `null` means "not a valid header list" and nothing more specific. The reason is
 * deliberately not reported: a message that said which pair failed, or how, would
 * be a message describing a credential, and it would travel into a startup log
 * and a validation error.
 */
export function parseOtlpHeaders(value: string): OtlpHeaders | null {
  if (value.length === 0 || value.length > MAX_OTLP_HEADERS_LENGTH) {
    return null;
  }

  // Checked on the whole value before it is split, so a newline cannot hide in
  // the part of a pair the splitter would have discarded.
  if (/[\r\n]/.test(value)) {
    return null;
  }

  const pairs = value.split(",");

  if (pairs.length > MAX_OTLP_HEADERS) {
    return null;
  }

  const headers: Record<string, string> = {};

  for (const pair of pairs) {
    const separator = pair.indexOf("=");

    // A value may contain `=`; a name may not, so only the first one separates.
    if (separator <= 0) {
      return null;
    }

    const name = pair.slice(0, separator);
    const headerValue = pair.slice(separator + 1);

    if (
      name.length > MAX_OTLP_HEADER_NAME_LENGTH ||
      !headerNamePattern.test(name)
    ) {
      return null;
    }

    if (
      headerValue.length === 0 ||
      headerValue.length > MAX_OTLP_HEADER_VALUE_LENGTH ||
      !headerValuePattern.test(headerValue)
    ) {
      return null;
    }

    const canonical = name.toLowerCase();

    // A repeated name is a mistake, not a request to merge: HTTP would join the
    // two with a comma, which is almost never what the operator meant.
    if (canonical in headers) {
      return null;
    }

    headers[canonical] = headerValue;
  }

  return Object.freeze(headers);
}

export function isValidOtlpHeaders(value: unknown): value is string {
  return typeof value === "string" && parseOtlpHeaders(value) !== null;
}
