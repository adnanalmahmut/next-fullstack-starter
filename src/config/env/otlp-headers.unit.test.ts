import { describe, expect, it } from "vitest";

import {
  isValidOtlpHeaders,
  MAX_OTLP_HEADER_NAME_LENGTH,
  MAX_OTLP_HEADER_VALUE_LENGTH,
  MAX_OTLP_HEADERS,
  MAX_OTLP_HEADERS_LENGTH,
  parseOtlpHeaders,
} from "./otlp-headers";

describe("parsing an OTLP header list", () => {
  it("accepts a single pair and lowercases the name", () => {
    expect(parseOtlpHeaders("Authorization=Bearer-token")).toEqual({
      authorization: "Bearer-token",
    });
  });

  it("accepts several pairs", () => {
    expect(parseOtlpHeaders("a=1,b=2,c=3")).toEqual({
      a: "1",
      b: "2",
      c: "3",
    });
  });

  it("keeps an equals sign inside a value", () => {
    // Only the first `=` separates, because a name may not contain one and a
    // base64 value routinely ends with one.
    expect(parseOtlpHeaders("authorization=abc==")).toEqual({
      authorization: "abc==",
    });
  });

  it("answers a frozen object", () => {
    expect(Object.isFrozen(parseOtlpHeaders("a=1"))).toBe(true);
  });
});

describe("refusing an unusable header list", () => {
  it.each([
    { name: "an empty value", value: "" },
    { name: "a pair with no separator", value: "authorization" },
    { name: "a pair with no name", value: "=value" },
    { name: "a pair with no value", value: "authorization=" },
    { name: "a name with a space", value: "auth orization=value" },
    { name: "a name with a separator", value: "auth:orization=value" },
    { name: "a value with a space", value: "authorization=Bearer token" },
    { name: "a value with a tab", value: "authorization=Bearer\ttoken" },
    { name: "a repeated name", value: "a=1,A=2" },
    { name: "a non-ASCII value", value: "authorization=café" },
  ])("refuses $name", ({ value }) => {
    expect(parseOtlpHeaders(value)).toBeNull();
    expect(isValidOtlpHeaders(value)).toBe(false);
  });

  it.each([
    { name: "a carriage return", value: "a=1\rx=2" },
    { name: "a line feed", value: "a=1\nx=2" },
    { name: "a CRLF sequence", value: "a=1\r\nx: injected" },
  ])("refuses $name, because it is header injection", ({ value }) => {
    expect(parseOtlpHeaders(value)).toBeNull();
  });

  it("refuses more pairs than the bound allows", () => {
    const withinBound = Array.from(
      { length: MAX_OTLP_HEADERS },
      (_, index) => `h${index}=v`,
    ).join(",");
    const overBound = `${withinBound},extra=v`;

    expect(parseOtlpHeaders(withinBound)).not.toBeNull();
    expect(parseOtlpHeaders(overBound)).toBeNull();
  });

  it("refuses a name longer than the bound", () => {
    const name = "n".repeat(MAX_OTLP_HEADER_NAME_LENGTH);

    expect(parseOtlpHeaders(`${name}=v`)).not.toBeNull();
    expect(parseOtlpHeaders(`${name}x=v`)).toBeNull();
  });

  it("refuses a value longer than the bound", () => {
    const value = "v".repeat(MAX_OTLP_HEADER_VALUE_LENGTH);

    expect(parseOtlpHeaders(`a=${value}`)).not.toBeNull();
    expect(parseOtlpHeaders(`a=${value}v`)).toBeNull();
  });

  it("refuses a list longer than the overall bound", () => {
    expect(
      parseOtlpHeaders(`a=${"v".repeat(MAX_OTLP_HEADERS_LENGTH)}`),
    ).toBeNull();
  });
});
