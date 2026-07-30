import createMiddleware from "next-intl/middleware";
import type { NextRequest } from "next/server";

import { i18nConfig } from "./i18n/config";
import { resolveLocaleFromPathname } from "./i18n/resolve-locale";
import { routing } from "./i18n/routing";
import {
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "./platform/observability/request-id.server";

const handleI18nRouting = createMiddleware(routing);

export default function proxy(request: NextRequest) {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
  request.headers.set(REQUEST_ID_HEADER, requestId);

  const response = handleI18nRouting(request);
  const locale = resolveLocaleFromPathname(request.nextUrl.pathname);

  const { name, ...cookieOptions } = i18nConfig.localeCookie;
  const currentCookie = request.cookies.get(name)?.value;

  if (currentCookie !== locale) {
    response.cookies.set(name, locale, cookieOptions);
  }

  response.headers.set(REQUEST_ID_HEADER, requestId);

  return response;
}

export const config = {
  matcher: "/((?!api|trpc|_next|_vercel|.*\\..*).*)",
};
