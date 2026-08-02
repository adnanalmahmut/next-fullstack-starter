/**
 * The download filename, and the header it becomes.
 *
 * A caller may ask that a signed download arrive with a particular name. That
 * name reaches a `Content-Disposition` header, which makes it the one value in
 * the download path that a client controls and that lands in an HTTP header —
 * so it is treated as hostile input. A newline in it would be a response
 * splitting attempt; a slash would be a path; a control character would be a
 * way to confuse whatever writes the file.
 *
 * The original upload filename is never used for this and is never even stored.
 * A caller that wants a friendly name supplies one it chose, which is a
 * decision it is in a position to make and this platform is not.
 */
export const MAX_DOWNLOAD_FILENAME_BYTES = 200;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/**
 * `true` when the value can be used as a download filename.
 *
 * Unicode is allowed — refusing it would mean an Arabic or Chinese filename
 * could never be offered, which is not a security position, it is a defect. It
 * is carried in the RFC 5987 `filename*` parameter, where it is percent-encoded
 * and cannot inject anything.
 */
export function isSafeDownloadFilename(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed !== value) {
    return false;
  }

  if (Buffer.byteLength(value, "utf8") > MAX_DOWNLOAD_FILENAME_BYTES) {
    return false;
  }

  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.includes('"') ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return false;
  }

  // A name that is only dots is a path reference rather than a file name.
  return value !== "." && value !== ".." && !value.includes("..");
}

export function assertSafeDownloadFilename(value: unknown): string {
  if (!isSafeDownloadFilename(value)) {
    throw new Error("The download filename is not usable in a header.");
  }

  return value;
}

/**
 * The ASCII fallback, for the plain `filename` parameter.
 *
 * Everything outside printable ASCII becomes an underscore. A client that
 * understands RFC 5987 reads `filename*` and sees the real name; one that does
 * not gets something safe rather than something mangled into a header break —
 * and usually keeps the extension, because `تقرير.pdf` transliterates to
 * `______.pdf`.
 *
 * A name with nothing recognizable left becomes `download`. A row of
 * underscores is technically safe and practically useless, and the point of the
 * fallback is to give the old client something it can save.
 */
function toAsciiFallback(value: string): string {
  const ascii = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;

      return code >= 0x20 && code <= 0x7e && character !== '"'
        ? character
        : "_";
    })
    .join("");

  return /[A-Za-z0-9]/.test(ascii) ? ascii : "download";
}

/**
 * Builds a `Content-Disposition` value for an attachment.
 *
 * Both forms are emitted, in the order RFC 6266 recommends: the ASCII
 * `filename` first for old clients, then `filename*` with the UTF-8 original.
 */
export function toContentDisposition(filename: string): string {
  const safe = assertSafeDownloadFilename(filename);
  const encoded = encodeURIComponent(safe);

  return `attachment; filename="${toAsciiFallback(safe)}"; filename*=UTF-8''${encoded}`;
}
