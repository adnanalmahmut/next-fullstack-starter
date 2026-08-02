import { describe, expect, it } from "vitest";

import {
  assertSafeDownloadFilename,
  isSafeDownloadFilename,
  MAX_DOWNLOAD_FILENAME_BYTES,
  toContentDisposition,
} from "./safe-filename";

describe("what may become a download filename", () => {
  it("accepts a plain ASCII name", () => {
    expect(isSafeDownloadFilename("invoice-2026.pdf")).toBe(true);
  });

  it("accepts Unicode, because refusing it would be a defect", () => {
    expect(isSafeDownloadFilename("تقرير سنوي.pdf")).toBe(true);
    expect(isSafeDownloadFilename("報告書.pdf")).toBe(true);
    expect(isSafeDownloadFilename("résumé.pdf")).toBe(true);
  });

  it("refuses a path in either direction", () => {
    expect(isSafeDownloadFilename("../../etc/passwd")).toBe(false);
    expect(isSafeDownloadFilename("folder/file.pdf")).toBe(false);
    expect(isSafeDownloadFilename("folder\\file.pdf")).toBe(false);
  });

  it("refuses a header break", () => {
    // The value reaches a `Content-Disposition` header, so a newline in it is a
    // response splitting attempt rather than a formatting mistake.
    expect(isSafeDownloadFilename("a\r\nSet-Cookie: x=1")).toBe(false);
    expect(isSafeDownloadFilename("a\nb.pdf")).toBe(false);
    expect(isSafeDownloadFilename("a\rb.pdf")).toBe(false);
  });

  it("refuses control characters and a quote", () => {
    expect(isSafeDownloadFilename("a\u0000b.pdf")).toBe(false);
    expect(isSafeDownloadFilename("a\u001bb.pdf")).toBe(false);
    expect(isSafeDownloadFilename("a\u007fb.pdf")).toBe(false);
    expect(isSafeDownloadFilename('a"b.pdf')).toBe(false);
  });

  it("refuses an empty, blank, or untrimmed name", () => {
    expect(isSafeDownloadFilename("")).toBe(false);
    expect(isSafeDownloadFilename("   ")).toBe(false);
    expect(isSafeDownloadFilename(" leading.pdf")).toBe(false);
    expect(isSafeDownloadFilename("trailing.pdf ")).toBe(false);
  });

  it("refuses a name that is only a path reference", () => {
    expect(isSafeDownloadFilename(".")).toBe(false);
    expect(isSafeDownloadFilename("..")).toBe(false);
  });

  it("bounds the length in bytes rather than characters", () => {
    expect(
      isSafeDownloadFilename("a".repeat(MAX_DOWNLOAD_FILENAME_BYTES)),
    ).toBe(true);
    expect(
      isSafeDownloadFilename("a".repeat(MAX_DOWNLOAD_FILENAME_BYTES + 1)),
    ).toBe(false);
    // Arabic letters are two bytes each, so the ceiling is reached at half the
    // character count. Counting characters would let a name through that is
    // twice the size the header was budgeted for.
    expect(isSafeDownloadFilename("ت".repeat(101))).toBe(false);
  });

  it("refuses anything that is not a string", () => {
    expect(isSafeDownloadFilename(null)).toBe(false);
    expect(isSafeDownloadFilename(42)).toBe(false);
    expect(isSafeDownloadFilename(undefined)).toBe(false);
  });

  it("throws when asserted on a name it refuses", () => {
    expect(() => assertSafeDownloadFilename("ok.pdf")).not.toThrow();
    expect(() => assertSafeDownloadFilename("a\nb")).toThrow();
  });
});

describe("the header it becomes", () => {
  it("emits both the ASCII form and the UTF-8 form", () => {
    expect(toContentDisposition("invoice.pdf")).toBe(
      `attachment; filename="invoice.pdf"; filename*=UTF-8''invoice.pdf`,
    );
  });

  it("percent-encodes a Unicode name and leaves a safe ASCII fallback", () => {
    const header = toContentDisposition("تقرير.pdf");

    expect(header.startsWith('attachment; filename="')).toBe(true);
    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain(encodeURIComponent("تقرير.pdf"));
    // A client that does not understand RFC 5987 gets something safe rather
    // than something mangled.
    expect(header).toMatch(/filename="[\x20-\x7e]+"/);
  });

  it("never produces a header that could break the response", () => {
    for (const name of ["a b.pdf", "تقرير سنوي.pdf", "100%.pdf", "a;b.pdf"]) {
      const header = toContentDisposition(name);

      expect(header).not.toContain("\n");
      expect(header).not.toContain("\r");
      expect(header.split('"')).toHaveLength(3);
    }
  });

  it("falls back to a usable name when nothing is ASCII", () => {
    expect(toContentDisposition("تقرير")).toContain('filename="download"');
  });

  it("refuses to build a header from a name it would not accept", () => {
    expect(() => toContentDisposition("a\r\nX: y")).toThrow();
  });
});
