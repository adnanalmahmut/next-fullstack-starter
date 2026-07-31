export type RouteArea =
  "public" | "auth" | "front-office" | "admin" | "api" | "unknown";

export type RouteRuleMatch = "exact" | "subtree";

export type RouteRule = {
  /** Pathname without a locale prefix for localized rules. */
  readonly pathname: string;
  /** `unknown` is the classifier default and cannot be declared. */
  readonly area: Exclude<RouteArea, "unknown">;
  readonly match: RouteRuleMatch;
  /** `true` when the URL carries a locale prefix for this area. */
  readonly localized: boolean;
};

/**
 * Rules for routes that exist in `src/app`. Areas without an implemented route
 * intentionally have no rule and stay `unknown` until their own feature adds
 * one. The first matching rule wins, so non-localized areas are declared first.
 */
export const applicationRouteRules: readonly RouteRule[] = [
  {
    pathname: "/api",
    area: "api",
    match: "subtree",
    localized: false,
  },
  {
    pathname: "/",
    area: "public",
    match: "exact",
    localized: true,
  },
  {
    pathname: "/design-system",
    area: "public",
    match: "exact",
    localized: true,
  },
];
