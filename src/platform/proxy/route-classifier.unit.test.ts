import { describe, expect, it } from "vitest";

import { classifyRoute } from "./route-classifier";
import type { RouteArea, RouteRule } from "./route-rules";

const locales = ["ar", "en"] as const;

/**
 * Fixture rules exercise the classification algorithm for every area. They are
 * not production routing: `applicationRouteRules` only declares routes that
 * exist in `src/app`.
 */
const fixtureRules: readonly RouteRule[] = [
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
    pathname: "/about",
    area: "public",
    match: "exact",
    localized: true,
  },
  {
    pathname: "/sign-in",
    area: "auth",
    match: "exact",
    localized: true,
  },
  {
    pathname: "/account",
    area: "front-office",
    match: "subtree",
    localized: true,
  },
  {
    pathname: "/admin",
    area: "admin",
    match: "subtree",
    localized: true,
  },
];

function classify(pathname: string, rules = fixtureRules): RouteArea {
  return classifyRoute({
    pathname,
    locales,
    rules,
  });
}

describe("classifyRoute", () => {
  it.each([
    { pathname: "/", expected: "public" },
    { pathname: "/ar", expected: "public" },
    { pathname: "/en", expected: "public" },
    { pathname: "/ar/about", expected: "public" },
    { pathname: "/en/about", expected: "public" },
    { pathname: "/ar/sign-in", expected: "auth" },
    { pathname: "/en/sign-in", expected: "auth" },
    { pathname: "/ar/account", expected: "front-office" },
    { pathname: "/en/account/settings/profile", expected: "front-office" },
    { pathname: "/ar/admin", expected: "admin" },
    { pathname: "/en/admin/users/42", expected: "admin" },
    { pathname: "/api", expected: "api" },
    { pathname: "/api/v1/products", expected: "api" },
  ] satisfies Array<{ pathname: string; expected: RouteArea }>)(
    "classifies $pathname as $expected",
    ({ pathname, expected }) => {
      expect(classify(pathname)).toBe(expected);
    },
  );

  it.each([
    { name: "an unmatched localized pathname", pathname: "/ar/reports" },
    { name: "an unmatched unprefixed pathname", pathname: "/reports" },
    { name: "an unsupported locale segment", pathname: "/fr/about" },
    { name: "a descendant of an exact rule", pathname: "/ar/about/team" },
    { name: "a localized API pathname", pathname: "/ar/api/v1" },
  ])("treats $name as unknown", ({ pathname }) => {
    expect(classify(pathname)).toBe("unknown");
  });

  it.each([
    { pathname: "/ar/administrator", expected: "unknown" },
    { pathname: "/ar/admins", expected: "unknown" },
    { pathname: "/ar/accountant", expected: "unknown" },
    { pathname: "/apifoo", expected: "unknown" },
    { pathname: "/ar/admin/", expected: "admin" },
    { pathname: "/api/", expected: "api" },
    { pathname: "//admin", expected: "admin" },
  ] satisfies Array<{ pathname: string; expected: RouteArea }>)(
    "respects segment boundaries for $pathname",
    ({ pathname, expected }) => {
      expect(classify(pathname)).toBe(expected);
    },
  );

  it("never classifies across a query string", () => {
    expect(classify("/ar/admin?tab=users")).toBe("unknown");
    expect(classify("/api?verbose=1")).toBe("unknown");
  });

  it("returns unknown for an empty rule list", () => {
    expect(classify("/", [])).toBe("unknown");
    expect(classify("/ar/admin", [])).toBe("unknown");
    expect(classify("/api/v1", [])).toBe("unknown");
  });

  it("uses the first matching rule", () => {
    const orderedRules: readonly RouteRule[] = [
      {
        pathname: "/admin",
        area: "admin",
        match: "subtree",
        localized: true,
      },
      {
        pathname: "/admin",
        area: "public",
        match: "subtree",
        localized: true,
      },
    ];

    expect(classify("/ar/admin/users", orderedRules)).toBe("admin");
  });
});
