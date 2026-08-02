import { describe, expect, it } from "vitest";

import {
  validateUploadFileDeclaration,
  type UploadFileDeclaration,
} from "./file-declaration";
import { defineUploadPolicy } from "./upload-policy";

const policy = defineUploadPolicy({
  name: "test.fixture",
  allowedFiles: [
    { contentType: "application/pdf", extensions: ["pdf"] },
    { contentType: "image/png", extensions: ["png"] },
  ],
  maxBytes: 1024,
});

const GLOBAL_MAX = 4096;

const declaration: UploadFileDeclaration = {
  contentType: "application/pdf",
  extension: "pdf",
  sizeBytes: 512,
  checksumSha256: "a".repeat(64),
};

function validate(overrides: Partial<UploadFileDeclaration> = {}) {
  return validateUploadFileDeclaration(
    { ...declaration, ...overrides },
    policy,
    GLOBAL_MAX,
  );
}

describe("validating a declaration", () => {
  it("accepts one the policy allows", () => {
    expect(validate()).toEqual(declaration);
  });

  it("refuses a media type the policy does not list", () => {
    expect(() =>
      validate({ contentType: "text/html", extension: "pdf" }),
    ).toThrow(/does not accept/);
  });

  it("refuses an extension that belongs to a different media type", () => {
    // The pair is what a client would have to get right. Accepting a PDF named
    // `png` would make the extension list decorative.
    expect(() => validate({ extension: "png" })).toThrow(
      /does not belong to the declared media type/,
    );
  });

  it("refuses a wildcard or malformed media type", () => {
    expect(() => validate({ contentType: "image/*" })).toThrow(
      /not a media type/,
    );
    expect(() => validate({ contentType: "" })).toThrow(/not a media type/);
  });

  it("refuses an extension that is not lowercase and dotless", () => {
    expect(() => validate({ extension: ".pdf" })).toThrow(/lowercase/);
    expect(() => validate({ extension: "PDF" })).toThrow(/lowercase/);
  });

  it("refuses a checksum that is not canonical", () => {
    expect(() => validate({ checksumSha256: "A".repeat(64) })).toThrow(
      /hexadecimal/,
    );
    expect(() => validate({ checksumSha256: "a".repeat(63) })).toThrow(
      /hexadecimal/,
    );
    expect(() => validate({ checksumSha256: "" })).toThrow(/hexadecimal/);
  });

  it("refuses a size that is not a positive integer", () => {
    for (const sizeBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() => validate({ sizeBytes })).toThrow(/positive integer/);
    }
  });

  it("refuses a size above the policy limit", () => {
    expect(() => validate({ sizeBytes: 1025 })).toThrow(
      /this upload policy allows/,
    );
  });

  it("refuses a size above the deployment limit even when the policy allows it", () => {
    const generous = defineUploadPolicy({
      name: "test.generous",
      allowedFiles: [{ contentType: "application/pdf", extensions: ["pdf"] }],
      maxBytes: 8192,
    });

    expect(() =>
      validateUploadFileDeclaration(
        { ...declaration, sizeBytes: 8000 },
        generous,
        GLOBAL_MAX,
      ),
    ).toThrow(/deployment upload limit/);
  });

  it("returns the declaration unchanged rather than normalizing it", () => {
    // What is stored has to be exactly what the client said, or a later
    // mismatch stops meaning anything.
    const result = validate();

    expect(result.checksumSha256).toBe(declaration.checksumSha256);
    expect(result.contentType).toBe(declaration.contentType);
  });
});
