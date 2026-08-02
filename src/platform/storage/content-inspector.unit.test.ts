import { describe, expect, it } from "vitest";

import {
  INSPECTION_OUTCOME,
  isValidInspectionReason,
  MAX_INSPECTION_REASON_LENGTH,
  toStoredInspectionReason,
  UNSPECIFIED_INSPECTION_REASON,
} from "./content-inspector";

describe("the inspection port", () => {
  it("has exactly two outcomes", () => {
    expect(Object.values(INSPECTION_OUTCOME)).toEqual(["clean", "quarantine"]);
  });
});

describe("the reason an inspector gives", () => {
  it("accepts a stable lowercase code", () => {
    expect(isValidInspectionReason("signature-match")).toBe(true);
    expect(isValidInspectionReason("unsupported")).toBe(true);
  });

  it("refuses anything that reads like a scanner message", () => {
    // A third-party engine's string is neither stable nor safe to store and
    // render: it can carry a path, a signature name, or the file's own bytes.
    expect(
      isValidInspectionReason("EICAR-Test-File found in /var/tmp/upload"),
    ).toBe(false);
    expect(isValidInspectionReason("Signature Match")).toBe(false);
    expect(
      isValidInspectionReason("a".repeat(MAX_INSPECTION_REASON_LENGTH + 1)),
    ).toBe(false);
    expect(isValidInspectionReason("")).toBe(false);
    expect(isValidInspectionReason("-leading")).toBe(false);
    expect(isValidInspectionReason(null)).toBe(false);
    expect(isValidInspectionReason(42)).toBe(false);
  });

  it("substitutes its own code rather than storing what it cannot vouch for", () => {
    expect(toStoredInspectionReason("signature-match")).toBe("signature-match");
    expect(toStoredInspectionReason("Malware.Win32 at offset 12")).toBe(
      UNSPECIFIED_INSPECTION_REASON,
    );
    expect(toStoredInspectionReason(undefined)).toBe(
      UNSPECIFIED_INSPECTION_REASON,
    );
    expect(toStoredInspectionReason({ code: "x" })).toBe(
      UNSPECIFIED_INSPECTION_REASON,
    );
  });
});
