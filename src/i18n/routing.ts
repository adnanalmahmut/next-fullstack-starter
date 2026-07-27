import { defineRouting } from "next-intl/routing";

import { i18nConfig, localePrefixMode } from "./config";

export const routing = defineRouting({
  locales: i18nConfig.locales,
  defaultLocale: i18nConfig.defaultLocale,
  localePrefix: localePrefixMode,
  localeDetection: i18nConfig.localeDetection,
  localeCookie: i18nConfig.localeCookie,
});
