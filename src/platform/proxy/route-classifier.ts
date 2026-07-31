import type { RouteArea, RouteRule, RouteRuleMatch } from "./route-rules";

type ClassifyRouteInput = {
  readonly pathname: string;
  readonly locales: readonly string[];
  readonly rules: readonly RouteRule[];
};

function toSegments(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

function matchesSegments(
  segments: readonly string[],
  ruleSegments: readonly string[],
  match: RouteRuleMatch,
): boolean {
  if (segments.length < ruleSegments.length) {
    return false;
  }

  if (match === "exact" && segments.length !== ruleSegments.length) {
    return false;
  }

  return ruleSegments.every((segment, index) => segment === segments[index]);
}

/**
 * Classifies a pathname into a route area.
 *
 * The classifier is pure: it never reads a session, decides authorization,
 * produces a response, or reaches for a framework API. Segment comparison keeps
 * `/admin` and `/administrator` distinct, and an unmatched pathname stays
 * `unknown` rather than defaulting to a permissive area.
 */
export function classifyRoute({
  pathname,
  locales,
  rules,
}: ClassifyRouteInput): RouteArea {
  const segments = toSegments(pathname);
  const hasLocalePrefix = segments.length > 0 && locales.includes(segments[0]);
  const localizedSegments = hasLocalePrefix ? segments.slice(1) : segments;

  const matchedRule = rules.find((rule) =>
    matchesSegments(
      rule.localized ? localizedSegments : segments,
      toSegments(rule.pathname),
      rule.match,
    ),
  );

  return matchedRule?.area ?? "unknown";
}
