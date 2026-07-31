import { i18nConfig, type AppLocale } from "@/i18n/config";

export const RETURN_TO_PARAM = "returnTo";

/**
 * The path an unauthenticated visitor is sent to after signing in.
 */
export function defaultReturnTo(locale: AppLocale): string {
  return `/${locale}/account`;
}

function isSupportedLocale(segment: string | undefined): boolean {
  if (segment === undefined) {
    return false;
  }

  return (i18nConfig.locales as readonly string[]).includes(segment);
}

/**
 * Accepts only an internal, locale-prefixed path.
 *
 * Anything that could leave the origin is rejected rather than repaired: an
 * absolute URL, a protocol-relative path, a backslash variant, an encoded
 * separator, or a scheme such as `javascript:`. A rejected value falls back to
 * the account page for the active locale, so a manipulated link can never
 * redirect a freshly authenticated visitor off-site.
 */
export function resolveSafeReturnTo(
  candidate: string | null | undefined,
  locale: AppLocale,
): string {
  const fallback = defaultReturnTo(locale);

  if (typeof candidate !== "string" || candidate.length === 0) {
    return fallback;
  }

  // Reject before any normalization: encoded forms must not be decoded into a
  // value that then looks internal.
  if (candidate.includes("\\") || candidate.includes("%")) {
    return fallback;
  }

  if (!candidate.startsWith("/") || candidate.startsWith("//")) {
    return fallback;
  }

  const [pathname] = candidate.split(/[?#]/);

  if (pathname === undefined) {
    return fallback;
  }

  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  if (!isSupportedLocale(segments[0])) {
    return fallback;
  }

  if (segments.includes("..") || segments.includes(".")) {
    return fallback;
  }

  return candidate;
}
