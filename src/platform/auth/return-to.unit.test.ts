import { describe, expect, it } from "vitest";

import {
  RETURN_TO_PARAM,
  defaultReturnTo,
  resolveSafeReturnTo,
} from "./return-to";

describe("defaultReturnTo", () => {
  it("points at the localized account page", () => {
    expect(defaultReturnTo("ar")).toBe("/ar/account");
    expect(defaultReturnTo("en")).toBe("/en/account");
  });
});

describe("RETURN_TO_PARAM", () => {
  it("keeps a stable query parameter name", () => {
    expect(RETURN_TO_PARAM).toBe("returnTo");
  });
});

describe("resolveSafeReturnTo", () => {
  it.each([
    "/ar/account",
    "/en/account",
    "/ar/design-system",
    "/en/account?tab=sessions",
    "/ar/account#details",
  ])("accepts the internal localized path %s", (candidate) => {
    expect(resolveSafeReturnTo(candidate, "ar")).toBe(candidate);
  });

  it.each([
    { name: "an absolute URL", candidate: "https://attacker.example" },
    { name: "an http URL", candidate: "http://attacker.example/ar/account" },
    { name: "a protocol-relative path", candidate: "//attacker.example" },
    { name: "a backslash bypass", candidate: "/\\attacker.example" },
    { name: "a mixed backslash path", candidate: "/ar\\..\\account" },
    { name: "an encoded separator", candidate: "%2F%2Fattacker.example" },
    { name: "an encoded internal path", candidate: "%2Far%2Faccount" },
    { name: "a javascript scheme", candidate: "javascript:alert(1)" },
    { name: "a data scheme", candidate: "data:text/html,<script>" },
    { name: "a relative path", candidate: "ar/account" },
    { name: "a traversal path", candidate: "/ar/../../etc/passwd" },
    { name: "an unprefixed path", candidate: "/account" },
    { name: "an unsupported locale", candidate: "/fr/account" },
    { name: "the bare root", candidate: "/" },
    { name: "an empty value", candidate: "" },
    { name: "a null value", candidate: null },
    { name: "an undefined value", candidate: undefined },
  ])("rejects $name", ({ candidate }) => {
    expect(resolveSafeReturnTo(candidate, "ar")).toBe("/ar/account");
  });

  it("falls back to the requested locale", () => {
    expect(resolveSafeReturnTo("https://attacker.example", "en")).toBe(
      "/en/account",
    );
  });

  it("never returns a value outside the origin", () => {
    const hostileCandidates = [
      "https://attacker.example",
      "//attacker.example",
      "/\\attacker.example",
      "%2F%2Fattacker.example",
      "javascript:alert(1)",
    ];

    for (const candidate of hostileCandidates) {
      const resolved = resolveSafeReturnTo(candidate, "ar");

      expect(resolved.startsWith("/")).toBe(true);
      expect(resolved.startsWith("//")).toBe(false);
      expect(resolved).not.toContain("attacker.example");
    }
  });
});
