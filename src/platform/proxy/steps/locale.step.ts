import createMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";

import { i18nConfig } from "@/i18n/config";
import { resolveLocaleFromPathname } from "@/i18n/resolve-locale";
import { routing } from "@/i18n/routing";

import type { ProxyContext } from "../context";

const handleI18nRouting = createMiddleware(routing);

/**
 * Runs locale negotiation for application pages and skips it for API routes.
 *
 * The response produced by `next-intl` is returned as-is so its status,
 * `Location`, rewrite metadata, locale header, `Set-Cookie` values, and
 * alternate-link header are preserved. API routes are not internationalized, so
 * they only receive the request-header forwarding that keeps the correlation ID
 * available upstream.
 */
export function applyLocaleRouting(context: ProxyContext): NextResponse {
  const { request } = context;

  if (context.area === "api") {
    return NextResponse.next({
      request: {
        headers: request.headers,
      },
    });
  }

  const response = handleI18nRouting(request);
  const locale = resolveLocaleFromPathname(request.nextUrl.pathname);

  const { name, ...cookieOptions } = i18nConfig.localeCookie;
  const currentCookie = request.cookies.get(name)?.value;

  if (currentCookie !== locale) {
    response.cookies.set(name, locale, cookieOptions);
  }

  return response;
}
