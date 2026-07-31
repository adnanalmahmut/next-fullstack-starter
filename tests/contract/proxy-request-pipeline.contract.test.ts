import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

import { isRequestContextDiagnosticEnabled } from "@/app/api/diagnostics/request-context/request-context-access";
import { i18nConfig } from "@/i18n/config";
import { REQUEST_ID_HEADER } from "@/platform/observability/request-id.server";
import { classifyRoute } from "@/platform/proxy/route-classifier";
import {
  applicationRouteRules,
  type RouteArea,
} from "@/platform/proxy/route-rules";
import { SECURITY_HEADERS } from "@/platform/proxy/steps/security-headers.step";
import * as proxyModule from "@/proxy";

const projectRoot = process.cwd();
const proxyEntryPath = "src/proxy.ts";
const proxyPipelineRoot = "src/platform/proxy";
const appRoot = resolve(projectRoot, "src/app");

const allowedExternalImports = ["next/server", "next-intl/middleware"];

const allowedInternalImports = [
  "@/i18n/config",
  "@/i18n/resolve-locale",
  "@/i18n/routing",
  "@/platform/observability/request-id.server",
];

const forbiddenImportPatterns = [
  /^@prisma(?:\/|$)/,
  /^prisma$/,
  /^@\/generated\/prisma(?:\/|$)/,
  /^@\/platform\/database(?:\/|$)/,
  /^@\/platform\/cache(?:\/|$)/,
  /^pg(?:\/|$)/,
  /^(?:redis|ioredis)(?:\/|$)/,
  /^@redis\//,
  /^bullmq(?:\/|$)/,
  /^better-auth(?:\/|$)/,
  /^@\/modules(?:\/|$)/,
  /^@\/ui(?:\/|$)/,
  /^react(?:-dom)?(?:\/|$)/,
];

function readProjectFile(filePath: string): string {
  return readFileSync(resolve(projectRoot, filePath), "utf8");
}

/**
 * Removes documentation so behavioral assertions inspect code rather than the
 * prose that explains which concerns the pipeline deliberately excludes.
 */
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function collectFiles(
  directory: string,
  predicate: (name: string) => boolean,
): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      return collectFiles(entryPath, predicate);
    }

    return predicate(entry.name) ? [entryPath] : [];
  });
}

const pipelineSourceFiles = [
  resolve(projectRoot, proxyEntryPath),
  ...collectFiles(
    resolve(projectRoot, proxyPipelineRoot),
    (name) => name.endsWith(".ts") && !name.endsWith(".unit.test.ts"),
  ),
].map((filePath) => ({
  path: relative(projectRoot, filePath).replaceAll("\\", "/"),
  source: readFileSync(filePath, "utf8"),
  code: stripComments(readFileSync(filePath, "utf8")),
}));

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+"([^"]+)"/g)].map(([, specifier]) => {
    if (specifier === undefined) {
      throw new Error("Unexpected import declaration without a specifier");
    }

    return specifier;
  });
}

/**
 * Routable pathnames derived from `src/app`, with route groups, private
 * folders, and the locale segment removed. Route groups such as `(development)`
 * never appear in a URL, so runtime classification must not depend on them.
 */
function collectRoutePathnames(): string[] {
  return collectFiles(
    appRoot,
    (name) => name === "page.tsx" || name === "route.ts",
  ).map((filePath) => {
    const segments = relative(appRoot, filePath)
      .replaceAll("\\", "/")
      .split("/")
      .slice(0, -1)
      .filter(
        (segment) =>
          !segment.startsWith("(") &&
          !segment.startsWith("_") &&
          segment !== "[locale]",
      );

    return `/${segments.join("/")}`;
  });
}

function classify(pathname: string): RouteArea {
  return classifyRoute({
    pathname,
    locales: i18nConfig.locales,
    rules: applicationRouteRules,
  });
}

describe("proxy composition root", () => {
  const source = readProjectFile(proxyEntryPath);
  const code = stripComments(source);

  it("exports only the proxy function and its config", () => {
    expect(Object.keys(proxyModule).sort()).toEqual(["config", "proxy"]);
    expect(typeof proxyModule.proxy).toBe("function");
    expect(proxyModule.proxy).toHaveLength(1);
  });

  it("delegates to the request pipeline without local logic", () => {
    expect(importSpecifiers(code)).toEqual([
      "next/server",
      "./platform/proxy/compose",
    ]);
    expect(source).toContain("return runRequestPipeline(request);");

    for (const statement of [
      "if (",
      "for (",
      "while (",
      "switch (",
      "try {",
      "headers.set(",
      "cookies.set(",
      "NextResponse",
    ]) {
      expect(code).not.toContain(statement);
    }
  });

  it("stays a small composition file", () => {
    expect(source.trimEnd().split("\n").length).toBeLessThanOrEqual(40);
  });
});

describe("proxy matcher contract", () => {
  it("declares a statically analyzable matcher", () => {
    expect(proxyModule.config.matcher).toEqual([
      "/((?!_next|_vercel|.*\\..*).*)",
      "/api/:path*",
    ]);
  });

  it.each([
    { url: "/", matches: true },
    { url: "/ar", matches: true },
    { url: "/en", matches: true },
    { url: "/ar/design-system", matches: true },
    { url: "/en/design-system", matches: true },
    { url: "/ar/unmatched", matches: true },
    { url: "/api", matches: true },
    { url: "/api/diagnostics/request-context", matches: true },
    { url: "/api/v1/report.pdf", matches: true },
    { url: "/_next/static/chunks/main.js", matches: false },
    { url: "/_next/image", matches: false },
    { url: "/_vercel/insights/script.js", matches: false },
    { url: "/favicon.ico", matches: false },
    { url: "/robots.txt", matches: false },
    { url: "/sitemap.xml", matches: false },
  ])("matches $url: $matches", ({ url, matches }) => {
    expect(
      unstable_doesMiddlewareMatch({
        config: proxyModule.config,
        url,
      }),
    ).toBe(matches);
  });
});

describe("proxy pipeline import boundaries", () => {
  it("imports nothing outside the allowed technical surface", () => {
    for (const { path, code } of pipelineSourceFiles) {
      for (const specifier of importSpecifiers(code)) {
        const isRelative = specifier.startsWith(".");
        const isAllowed =
          isRelative ||
          allowedExternalImports.includes(specifier) ||
          allowedInternalImports.includes(specifier);

        expect(isAllowed, `${path} imports ${specifier}`).toBe(true);
      }
    }
  });

  it("adds no runtime dependency beyond next and next-intl", () => {
    const externalImports = new Set(
      pipelineSourceFiles
        .flatMap(({ code }) => importSpecifiers(code))
        .filter(
          (specifier) =>
            !specifier.startsWith(".") && !specifier.startsWith("@/"),
        ),
    );

    expect([...externalImports].sort()).toEqual(
      [...allowedExternalImports].sort(),
    );
  });

  it.each(forbiddenImportPatterns.map((pattern) => ({ pattern })))(
    "never imports $pattern",
    ({ pattern }) => {
      for (const { path, code } of pipelineSourceFiles) {
        for (const specifier of importSpecifiers(code)) {
          expect(pattern.test(specifier), `${path} imports ${specifier}`).toBe(
            false,
          );
        }
      }
    },
  );
});

describe("proxy is not an authorization boundary", () => {
  it.each([
    { name: "session handling", pattern: /session/i },
    // `Permissions-Policy` is a response header, not an authorization concept.
    { name: "permission checks", pattern: /permission(?!s-Policy)/i },
    { name: "authorization decisions", pattern: /\bauthoriz/i },
    { name: "actor resolution", pattern: /\bactor\b/i },
    { name: "role comparisons", pattern: /\brole\b/i },
    { name: "rejection status codes", pattern: /\b(?:401|403)\b/ },
  ])("contains no $name", ({ pattern }) => {
    for (const { path, code } of pipelineSourceFiles) {
      expect(pattern.test(code), `${path} matches ${pattern}`).toBe(false);
    }
  });

  it("classifies without producing a response or a decision", () => {
    const classifierCode = stripComments(
      readProjectFile(`${proxyPipelineRoot}/route-classifier.ts`),
    );
    const rulesCode = stripComments(
      readProjectFile(`${proxyPipelineRoot}/route-rules.ts`),
    );

    for (const source of [classifierCode, rulesCode]) {
      expect(source).not.toContain("NextResponse");
      expect(source).not.toContain("NextRequest");
      expect(source).not.toContain("redirect");
      expect(source).not.toContain("cookies");
    }
  });

  it("reads only the locale cookie", () => {
    const cookieReads = pipelineSourceFiles.flatMap(({ code }) => [
      ...code.matchAll(/cookies\.(?:get|getAll|has)\(([^)]*)\)/g),
    ]);

    expect(cookieReads).toHaveLength(1);
    expect(cookieReads[0]?.[1]).toBe("name");
    expect(
      readProjectFile(`${proxyPipelineRoot}/steps/locale.step.ts`),
    ).toContain("const { name, ...cookieOptions } = i18nConfig.localeCookie;");
  });
});

describe("proxy security header contract", () => {
  it("applies exactly the baseline headers", () => {
    expect(SECURITY_HEADERS).toEqual({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
  });

  it.each([
    { pattern: /content-security-policy/i },
    { pattern: /strict-transport-security/i },
    { pattern: /access-control-allow/i },
    { pattern: /cross-origin-(?:opener|resource|embedder)-policy/i },
    { pattern: /x-xss-protection/i },
    { pattern: /nonce/i },
  ])("defers $pattern to its own policy decision", ({ pattern }) => {
    for (const { path, code } of pipelineSourceFiles) {
      expect(pattern.test(code), `${path} matches ${pattern}`).toBe(false);
    }
  });

  it("applies the headers in a single place", () => {
    const applyingFiles = pipelineSourceFiles.filter(({ code }) =>
      code.includes('"X-Frame-Options"'),
    );

    expect(applyingFiles.map(({ path }) => path)).toEqual([
      `${proxyPipelineRoot}/steps/security-headers.step.ts`,
    ]);
  });
});

describe("proxy request ID contract", () => {
  it("reuses the observability header contract", () => {
    expect(REQUEST_ID_HEADER).toBe("x-request-id");

    const requestIdStep = readProjectFile(
      `${proxyPipelineRoot}/steps/request-id.step.ts`,
    );

    expect(requestIdStep).toContain(
      'from "@/platform/observability/request-id.server"',
    );
    expect(requestIdStep).toContain(
      "request.headers.set(REQUEST_ID_HEADER, requestId)",
    );
    expect(requestIdStep).toContain(
      "response.headers.set(REQUEST_ID_HEADER, requestId)",
    );
  });

  it("defines no competing header name or validation", () => {
    for (const { path, code } of pipelineSourceFiles) {
      expect(code.includes('"x-request-id"'), path).toBe(false);
      expect(code.includes("randomUUID"), path).toBe(false);
    }
  });
});

describe("proxy response semantics", () => {
  it("never exposes request headers to the client", () => {
    for (const { path, code } of pipelineSourceFiles) {
      expect(
        /NextResponse\.next\(\s*\{\s*headers/.test(code),
        `${path} forwards request headers to the client`,
      ).toBe(false);
    }
  });

  it("mutates the existing response instead of rebuilding it", () => {
    for (const { path, code } of pipelineSourceFiles) {
      expect(code.includes("new NextResponse("), path).toBe(false);
      expect(code.includes("new Response("), path).toBe(false);
      expect(code.includes(".body"), path).toBe(false);
    }
  });

  it("forwards upstream headers through the request option", () => {
    const localeStep = readProjectFile(
      `${proxyPipelineRoot}/steps/locale.step.ts`,
    ).replaceAll(/\s+/g, " ");

    expect(localeStep).toContain(
      "NextResponse.next({ request: { headers: request.headers, }, })",
    );
  });
});

describe("proxy locale configuration", () => {
  it("keeps the established i18n contract unchanged", () => {
    expect(i18nConfig).toEqual({
      locales: ["ar", "en"],
      defaultLocale: "ar",
      prefixDefaultLocale: true,
      localeDetection: false,
      localeCookie: {
        name: "APP_LOCALE",
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 60 * 60 * 24 * 365,
      },
    });
  });

  it("adds no locale cookie beyond the configured one", () => {
    const cookieWrites = pipelineSourceFiles.flatMap(({ code }) => [
      ...code.matchAll(/cookies\.set\(([^,]+),/g),
    ]);

    expect(cookieWrites).toHaveLength(1);
    expect(cookieWrites[0]?.[1]).toBe("name");
  });
});

describe("proxy route rules", () => {
  it("declares only implemented areas", () => {
    for (const rule of applicationRouteRules) {
      expect(rule.pathname.startsWith("/")).toBe(true);
      expect(["public", "auth", "front-office", "admin", "api"]).toContain(
        rule.area,
      );
      expect(["exact", "subtree"]).toContain(rule.match);
    }
  });

  it("classifies every routable pathname in src/app", () => {
    const routePathnames = collectRoutePathnames();

    expect(routePathnames.sort()).toEqual([
      "/",
      "/account",
      "/api/auth/[...all]",
      "/api/diagnostics/auth-session",
      "/api/diagnostics/request-context",
      "/design-system",
      "/login",
    ]);

    for (const pathname of routePathnames) {
      expect(classify(pathname), pathname).not.toBe("unknown");
    }
  });

  it("declares no rule without a matching route", () => {
    const routePathnames = collectRoutePathnames();

    for (const rule of applicationRouteRules) {
      const matchedByRoute = routePathnames.some((pathname) => {
        const candidates = rule.localized
          ? i18nConfig.locales.map((locale) => `/${locale}${pathname}`)
          : [pathname];

        return candidates.some(
          (candidate) => classify(candidate) === rule.area,
        );
      });

      expect(matchedByRoute, `${rule.pathname} has no matching route`).toBe(
        true,
      );
    }
  });

  it("keeps the request-context diagnostic out of deployed environments", () => {
    expect(isRequestContextDiagnosticEnabled("development")).toBe(true);
    expect(isRequestContextDiagnosticEnabled("test")).toBe(true);
    expect(isRequestContextDiagnosticEnabled("staging")).toBe(false);
    expect(isRequestContextDiagnosticEnabled("production")).toBe(false);

    const routeSource = readProjectFile(
      "src/app/api/diagnostics/request-context/route.ts",
    );

    expect(routeSource).toContain("isRequestContextDiagnosticEnabled");
    expect(routeSource).toContain("status: 404");
    expect(routeSource).toContain("requestHeaders.get(REQUEST_ID_HEADER)");
  });

  it("keeps unimplemented areas unclassified", () => {
    const declaredAreas = new Set(
      applicationRouteRules.map((rule) => rule.area),
    );

    expect([...declaredAreas].sort()).toEqual([
      "api",
      "auth",
      "front-office",
      "public",
    ]);
    expect(classify("/ar/register")).toBe("unknown");
    expect(classify("/ar/admin")).toBe("unknown");
    expect(classify("/ar/reports")).toBe("unknown");
  });
});
