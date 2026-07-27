export const i18nConfig = {
  locales: ["ar", "en"] as const,
  defaultLocale: "ar" as const,
  prefixDefaultLocale: true,
  localeDetection: false,
  localeCookie: {
    name: "APP_LOCALE",
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  },
} as const;

export type AppLocale = (typeof i18nConfig.locales)[number];
export type LocalePrefixMode = "always" | "as-needed";

export function getLocalePrefixMode(
  prefixDefaultLocale: boolean,
): LocalePrefixMode {
  return prefixDefaultLocale ? "always" : "as-needed";
}

export const localePrefixMode = getLocalePrefixMode(
  i18nConfig.prefixDefaultLocale,
);

export function getLocaleDirection(locale: AppLocale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}
