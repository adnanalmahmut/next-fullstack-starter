import { describe, expect, it } from "vitest";

import {
  getLocaleDirection,
  getLocalePrefixMode,
  i18nConfig,
  localePrefixMode,
} from "./config";
import { resolveLocaleFromPathname } from "./resolve-locale";

describe("i18n configuration", () => {
  it("uses Arabic as the default locale", () => {
    expect(i18nConfig.defaultLocale).toBe("ar");
  });

  it("maps the default-locale prefix flag to next-intl modes", () => {
    expect(getLocalePrefixMode(true)).toBe("always");
    expect(getLocalePrefixMode(false)).toBe("as-needed");
  });

  it("derives the configured locale prefix mode", () => {
    expect(localePrefixMode).toBe(
      getLocalePrefixMode(i18nConfig.prefixDefaultLocale),
    );
  });

  it("maps locale directions", () => {
    expect(getLocaleDirection("ar")).toBe("rtl");
    expect(getLocaleDirection("en")).toBe("ltr");
  });
});

describe("resolveLocaleFromPathname", () => {
  it("resolves explicit supported locale prefixes", () => {
    expect(resolveLocaleFromPathname("/ar")).toBe("ar");
    expect(resolveLocaleFromPathname("/ar/products")).toBe("ar");
    expect(resolveLocaleFromPathname("/en")).toBe("en");
    expect(resolveLocaleFromPathname("/en/products")).toBe("en");
  });

  it("uses the default locale for unprefixed paths", () => {
    expect(resolveLocaleFromPathname("/")).toBe("ar");
    expect(resolveLocaleFromPathname("/products")).toBe("ar");
  });

  it("does not treat unsupported segments as locales", () => {
    expect(resolveLocaleFromPathname("/fr")).toBe("ar");
  });
});
