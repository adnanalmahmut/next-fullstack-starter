import { hasLocale } from "next-intl";

import { i18nConfig, type AppLocale } from "./config";

export function resolveLocaleFromPathname(pathname: string): AppLocale {
  const localeSegment = pathname.split("/")[1];

  return hasLocale(i18nConfig.locales, localeSegment)
    ? localeSegment
    : i18nConfig.defaultLocale;
}
