import { describe, expect, it } from "vitest";

import {
  defineUploadPolicy,
  isValidUploadContentType,
  isValidUploadExtension,
  isValidUploadPolicyName,
  UPLOAD_INSPECTION,
} from "./upload-policy";

const validDefinition = {
  name: "test.fixture",
  allowedFiles: [{ contentType: "application/pdf", extensions: ["pdf"] }],
  maxBytes: 5 * 1024 * 1024,
} as const;

describe("defining a policy", () => {
  it("builds one from a valid definition", () => {
    const policy = defineUploadPolicy(validDefinition);

    expect(policy.name).toBe("test.fixture");
    expect(policy.maxBytes).toBe(5 * 1024 * 1024);
    expect(policy.inspection).toBe(UPLOAD_INSPECTION.OPTIONAL);
    expect(policy.extensionsFor("application/pdf")).toEqual(["pdf"]);
    expect(policy.extensionsFor("image/png")).toEqual([]);
  });

  it("defaults inspection to optional and honours an explicit requirement", () => {
    expect(defineUploadPolicy(validDefinition).inspection).toBe("optional");
    expect(
      defineUploadPolicy({
        ...validDefinition,
        inspection: UPLOAD_INSPECTION.REQUIRED,
      }).inspection,
    ).toBe("required");
  });

  it("cannot be changed after it is built", () => {
    const policy = defineUploadPolicy(validDefinition);

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.allowedFiles)).toBe(true);
  });

  it("copies the definition rather than holding it", () => {
    const files = [{ contentType: "application/pdf", extensions: ["pdf"] }];
    const policy = defineUploadPolicy({
      ...validDefinition,
      allowedFiles: files,
    });

    files.push({ contentType: "text/html", extensions: ["html"] });

    expect(policy.allowedFiles).toHaveLength(1);
    expect(policy.extensionsFor("text/html")).toEqual([]);
  });

  it("refuses a name that is not <owner>.<purpose>", () => {
    for (const name of [
      "fixture",
      "test.fixture.extra",
      "Test.Fixture",
      "test fixture",
      "test.",
      ".fixture",
      "test.*",
      "a".repeat(70),
      "",
    ]) {
      expect(() => defineUploadPolicy({ ...validDefinition, name })).toThrow();
    }
  });

  it("refuses a wildcard media type", () => {
    // `image/*` would admit `image/svg+xml`, which is a document that executes
    // script in the browser that opens it. That is how an allowlist quietly
    // becomes a denylist.
    expect(() =>
      defineUploadPolicy({
        ...validDefinition,
        allowedFiles: [{ contentType: "image/*", extensions: ["png"] }],
      }),
    ).toThrow();
    expect(() =>
      defineUploadPolicy({
        ...validDefinition,
        allowedFiles: [{ contentType: "*/*", extensions: ["png"] }],
      }),
    ).toThrow();
  });

  it("refuses an uppercase media type or extension", () => {
    expect(() =>
      defineUploadPolicy({
        ...validDefinition,
        allowedFiles: [{ contentType: "Application/PDF", extensions: ["pdf"] }],
      }),
    ).toThrow();
    expect(() =>
      defineUploadPolicy({
        ...validDefinition,
        allowedFiles: [{ contentType: "application/pdf", extensions: ["PDF"] }],
      }),
    ).toThrow();
  });

  it("refuses an extension that carries a dot", () => {
    expect(() =>
      defineUploadPolicy({
        ...validDefinition,
        allowedFiles: [
          { contentType: "application/pdf", extensions: [".pdf"] },
        ],
      }),
    ).toThrow();
  });

  it("refuses a media type declared twice", () => {
    expect(() =>
      defineUploadPolicy({
        ...validDefinition,
        allowedFiles: [
          { contentType: "application/pdf", extensions: ["pdf"] },
          { contentType: "application/pdf", extensions: ["pdfa"] },
        ],
      }),
    ).toThrow();
  });

  it("refuses one extension claimed by two media types", () => {
    // Two owners for `pdf` would make "which type is this extension" a question
    // with two answers, decided by iteration order at upload time.
    expect(() =>
      defineUploadPolicy({
        ...validDefinition,
        allowedFiles: [
          { contentType: "application/pdf", extensions: ["pdf"] },
          { contentType: "application/x-pdf", extensions: ["pdf"] },
        ],
      }),
    ).toThrow();
  });

  it("refuses a media type with no extensions, and an empty allowlist", () => {
    expect(() =>
      defineUploadPolicy({
        ...validDefinition,
        allowedFiles: [{ contentType: "application/pdf", extensions: [] }],
      }),
    ).toThrow();
    expect(() =>
      defineUploadPolicy({ ...validDefinition, allowedFiles: [] }),
    ).toThrow();
  });

  it("refuses a size limit that is not a positive integer", () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        defineUploadPolicy({ ...validDefinition, maxBytes }),
      ).toThrow();
    }
  });

  it("refuses a limit above the deployment ceiling", () => {
    expect(() =>
      defineUploadPolicy({ ...validDefinition, maxBytes: 100 }, 50),
    ).toThrow();
    expect(() =>
      defineUploadPolicy({ ...validDefinition, maxBytes: 50 }, 50),
    ).not.toThrow();
  });
});

describe("the shapes a policy is held to", () => {
  it("recognizes a policy name", () => {
    expect(isValidUploadPolicyName("billing.invoice")).toBe(true);
    expect(isValidUploadPolicyName("billing.invoice-scan")).toBe(true);
    expect(isValidUploadPolicyName("billing")).toBe(false);
    expect(isValidUploadPolicyName(null)).toBe(false);
  });

  it("recognizes an exact media type", () => {
    expect(isValidUploadContentType("application/pdf")).toBe(true);
    expect(isValidUploadContentType("image/svg+xml")).toBe(true);
    expect(isValidUploadContentType("application/vnd.ms-excel")).toBe(true);
    expect(isValidUploadContentType("image/*")).toBe(false);
    expect(isValidUploadContentType("application/pdf; charset=utf-8")).toBe(
      false,
    );
    expect(isValidUploadContentType(`a/${"b".repeat(200)}`)).toBe(false);
    expect(isValidUploadContentType(7)).toBe(false);
  });

  it("recognizes an extension", () => {
    expect(isValidUploadExtension("pdf")).toBe(true);
    expect(isValidUploadExtension("docx")).toBe(true);
    expect(isValidUploadExtension("7z")).toBe(true);
    expect(isValidUploadExtension("tar.gz")).toBe(false);
    expect(isValidUploadExtension("")).toBe(false);
    expect(isValidUploadExtension("a".repeat(17))).toBe(false);
    expect(isValidUploadExtension(undefined)).toBe(false);
  });
});
