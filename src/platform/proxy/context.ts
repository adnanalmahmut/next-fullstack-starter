import type { NextRequest } from "next/server";

import { i18nConfig } from "@/i18n/config";

import { classifyRoute } from "./route-classifier";
import { applicationRouteRules, type RouteArea } from "./route-rules";

type CreateProxyContextInput = {
  readonly request: NextRequest;
  readonly requestId: string;
};

/**
 * The data a proxy step needs. It deliberately excludes an actor, a session,
 * permissions, a database client, a cache client, and any service container:
 * the proxy is not an authorization boundary and must not become a service
 * locator.
 */
export type ProxyContext = {
  readonly request: NextRequest;
  readonly pathname: string;
  readonly area: RouteArea;
  readonly requestId: string;
};

export function createProxyContext({
  request,
  requestId,
}: CreateProxyContextInput): ProxyContext {
  const { pathname } = request.nextUrl;

  return {
    request,
    pathname,
    area: classifyRoute({
      pathname,
      locales: i18nConfig.locales,
      rules: applicationRouteRules,
    }),
    requestId,
  };
}
