import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { ESLint } from "eslint";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ERROR_CODE } from "@/shared/errors/error-code";

/**
 * The Route Handler boundary contract.
 *
 * Three kinds of assertion appear here. The inventory assertions prove that the
 * application's HTTP surface is versioned and that every endpoint on it is built
 * by the factory, because that is a property of the tree rather than of any one
 * file. The source assertions prove the adapter cannot reach a database, a
 * business module, or a transport. The behavioural assertions run real route
 * definitions from the fixture and prove the guarantees a client depends on: one
 * envelope, a stable code, and a correlation header on every answer.
 */
const projectRoot = process.cwd();
const httpRoot = "src/platform/http";
const apiRoot = "src/app/api";
const versionedPrefix = "src/app/api/v1/";
const fixturePath = "tests/fixtures/route-handler.fixture.ts";

/**
 * The Better Auth catch-all. It is provider owned: Better Auth validates,
 * authorizes, and serializes its own endpoints, and the application's guard hook
 * already applies the capability, the resource policies, and the audit record to
 * them. Wrapping it in `defineRoute` would duplicate all of that.
 */
const betterAuthRoute = "src/app/api/auth/[...all]/route.ts";

/**
 * Development and test diagnostics. They are not application endpoints and are
 * not part of the versioned API: each one answers `404` outside development and
 * test, and each exists to prove a property of the infrastructure — that a Route
 * Handler validates a session on the server, and that the proxy propagates the
 * correlation header upstream. The second could not prove anything through the
 * factory, which resolves a correlation id of its own when none arrives.
 */
const diagnosticRoutes = [
  "src/app/api/diagnostics/auth-session/route.ts",
  "src/app/api/diagnostics/request-context/route.ts",
];

function read(filePath: string): string {
  return readFileSync(resolve(projectRoot, filePath), "utf8");
}

function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function readImports(source: string): string[] {
  return Array.from(
    stripComments(source).matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g),
    (match) => match[1] ?? "",
  );
}

function collectFiles(directory: string, name: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      return collectFiles(entryPath, name);
    }

    return entry.name === name ? [entryPath] : [];
  });
}

const routeFiles = collectFiles(resolve(projectRoot, apiRoot), "route.ts")
  .map((filePath) => relative(projectRoot, filePath).replaceAll("\\", "/"))
  .sort();

const versionedRoutes = routeFiles.filter((path) =>
  path.startsWith(versionedPrefix),
);

const productionFiles = readdirSync(resolve(projectRoot, httpRoot))
  .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
  .map((name) => `${httpRoot}/${name}`);

const factoryImports = productionFiles.flatMap((path) =>
  readImports(read(path)),
);

/** Behavioural setup. Only the Better Auth edge is replaced. */
const getSession = vi.fn();
const userHasPermission = vi.fn();

vi.mock("@/platform/auth/auth.server", () => ({
  auth: {
    api: {
      getSession: (options: unknown) => getSession(options),
      userHasPermission: (options: unknown) => userHasPermission(options),
    },
  },
}));

const {
  GET_GREETING,
  PATCH_ROLE,
  POST_REVOKE,
  clearRouteExecutionLog,
  readRouteExecutionLog,
} = await import("../fixtures/route-handler.fixture");

const REQUEST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

function request(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    ...init,
    headers: { "x-request-id": REQUEST_ID, ...(init.headers ?? {}) },
  } as ConstructorParameters<typeof NextRequest>[1]);
}

function context(params: unknown = {}) {
  return { params: Promise.resolve(params) };
}

function signIn(): void {
  getSession.mockResolvedValue({
    session: { id: "session-1", userId: "user-1" },
    user: {
      id: "user-1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      role: "admin",
    },
  });
}

beforeEach(() => {
  getSession.mockReset();
  userHasPermission.mockReset();
  getSession.mockResolvedValue(null);
  userHasPermission.mockResolvedValue({ success: false });
  clearRouteExecutionLog();
});

describe("API surface", () => {
  it("has an inventory that is fully accounted for", () => {
    expect(routeFiles).toEqual(
      [betterAuthRoute, ...diagnosticRoutes, ...versionedRoutes].sort(),
    );
  });

  it("serves every application endpoint under the versioned prefix", () => {
    expect(versionedRoutes).toEqual([
      "src/app/api/v1/admin/audit/route.ts",
      "src/app/api/v1/admin/users/[userId]/role/route.ts",
      "src/app/api/v1/admin/users/[userId]/route.ts",
      "src/app/api/v1/admin/users/[userId]/sessions/revoke/route.ts",
      "src/app/api/v1/admin/users/route.ts",
    ]);
  });

  it("keeps no unversioned copy of a moved endpoint", () => {
    expect(existsSync(resolve(projectRoot, "src/app/api/admin"))).toBe(false);
  });

  it("exempts the Better Auth catch-all and nothing else that is deployed", () => {
    const unversioned = routeFiles.filter(
      (path) => !path.startsWith(versionedPrefix),
    );

    expect(unversioned).toEqual([betterAuthRoute, ...diagnosticRoutes].sort());
    expect(read(betterAuthRoute)).toContain("toNextJsHandler");
  });

  it("gates every unversioned route that is not provider owned", () => {
    for (const path of diagnosticRoutes) {
      const source = read(path);

      expect(source).toMatch(/isr?\w*DiagnosticEnabled/i);
      expect(source).toContain("status: 404");
    }
  });

  it("never applies the factory to the Better Auth catch-all", () => {
    const source = stripComments(read(betterAuthRoute));

    expect(source).not.toContain("defineRoute");
    expect(readImports(source)).not.toContain("@/platform/http/index.server");
  });
});

describe("route adapters", () => {
  it("builds every versioned endpoint through the factory", () => {
    for (const path of versionedRoutes) {
      const source = stripComments(read(path));

      expect(readImports(source), path).toContain(
        "@/platform/http/index.server",
      );
      expect(source, path).toMatch(/export const [A-Z]+ = defineRoute\(\{/);
    }
  });

  it("exports only HTTP methods built by the factory", () => {
    for (const path of versionedRoutes) {
      const source = stripComments(read(path));
      const exports = Array.from(
        source.matchAll(/^export const (\w+) = (\w+)\(/gm),
        (match) => [match[1], match[2]] as const,
      );

      expect(exports.length, path).toBeGreaterThan(0);

      for (const [name, factory] of exports) {
        expect(["GET", "POST", "PUT", "PATCH", "DELETE"], path).toContain(name);
        expect(factory, path).toBe("defineRoute");
      }

      expect(source, path).not.toMatch(/^export\s+(?:async\s+)?function\s/m);
    }
  });

  it("declares a unique, stable route name for every endpoint", () => {
    const names = versionedRoutes.map((path) => {
      const [, name] =
        /name:\s*"([^"]+)"/.exec(stripComments(read(path))) ?? [];

      expect(name, path).toBeDefined();

      return name;
    });

    expect(new Set(names).size).toBe(names.length);

    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
    }
  });

  it.each([
    { name: "Prisma", pattern: /^(?:@prisma(?:\/|$)|prisma$|@\/generated)/ },
    { name: "the database platform", pattern: /^@\/platform\/database/ },
    { name: "the PostgreSQL driver", pattern: /^pg(?:\/|$)/ },
    { name: "Better Auth", pattern: /^better-auth/ },
    { name: "the response serializer", pattern: /^@\/platform\/http\/json/ },
    { name: "the capability gate", pattern: /require-permission/ },
    { name: "the actor reader", pattern: /authorization\/actor/ },
    { name: "a Next.js request API", pattern: /^next\/(?:headers|server)$/ },
  ])("never imports $name into an adapter", ({ pattern }) => {
    for (const path of versionedRoutes) {
      expect(
        readImports(read(path)).filter((source) => pattern.test(source)),
        path,
      ).toEqual([]);
    }
  });

  it.each([
    { name: "an error mapping", pattern: /\btry\s*\{|\bcatch\s*\(/ },
    {
      name: "response serialization",
      pattern: /Response\.json|new Response|NextResponse/,
    },
    { name: "body reading", pattern: /\.json\(\)|\.formData\(\)|\.text\(\)/ },
    { name: "input parsing", pattern: /\.(?:safe)?[pP]arse(?:Async)?\(/ },
    {
      name: "a capability check",
      pattern: /require(?:Actor|Permission|AnyPermission|AllPermissions)\(/,
    },
    {
      name: "a session read",
      pattern: /getSession|getCurrentActor|cookies\(\)|headers\(\)/,
    },
    { name: "a role comparison", pattern: /["'](?:admin|user)["']/ },
    { name: "a permission literal", pattern: /permission:\s*["']/ },
    {
      name: "control flow",
      pattern: /\bif\s*\(|\bswitch\s*\(|\bfor\s*\(|\bwhile\s*\(/,
    },
  ])("never restates $name in an adapter", ({ pattern }) => {
    for (const path of versionedRoutes) {
      expect(stripComments(read(path)), path).not.toMatch(pattern);
    }
  });

  it("keeps the fixture definitions representative of a real adapter", () => {
    // The behavioural assertions below are only meaningful if the fixture is
    // written the way an endpoint is: declaring, never restating.
    const source = stripComments(read(fixturePath));

    expect(source.match(/defineRoute\(/g)?.length ?? 0).toBeGreaterThan(1);
    expect(readImports(source)).toContain("@/platform/http/index.server");
    expect(source).toContain("PERMISSION.");

    for (const pattern of [
      /\btry\s*\{/,
      /Response\.json|new Response/,
      /\.json\(\)/,
      /\.(?:safe)?[pP]arse(?:Async)?\(/,
      /require(?:Actor|Permission)\(/,
      /permission:\s*["']/,
    ]) {
      expect(source, String(pattern)).not.toMatch(pattern);
    }
  });

  it("stays thin", () => {
    for (const path of versionedRoutes) {
      const statements = stripComments(read(path))
        .split("\n")
        .filter((line) => line.trim().length > 0);

      expect(statements.length, path).toBeLessThan(35);
    }
  });
});

describe("factory boundaries", () => {
  it("marks every server module with the server-only guard", () => {
    const serverOnlyFiles = productionFiles.filter((path) =>
      path.includes(".server."),
    );

    expect(serverOnlyFiles.length).toBeGreaterThan(0);

    for (const path of serverOnlyFiles) {
      expect(read(path).startsWith('import "server-only";'), path).toBe(true);
    }
  });

  it("keeps the controlled entry point server-only", () => {
    expect(read(`${httpRoot}/index.server.ts`)).toContain(
      'import "server-only";',
    );
  });

  it.each([
    { name: "Prisma", pattern: /^(?:@prisma(?:\/|$)|prisma$|@\/generated)/ },
    { name: "the database platform", pattern: /^@\/platform\/database/ },
    { name: "the PostgreSQL driver", pattern: /^pg(?:\/|$)/ },
    { name: "Redis", pattern: /^(?:(?:redis|ioredis)(?:\/|$)|@redis\/)/ },
    { name: "a queue", pattern: /^bullmq/ },
    { name: "Better Auth", pattern: /^better-auth/ },
    { name: "a business module", pattern: /^@\/modules/ },
    { name: "application routing", pattern: /^@\/app(?:\/|$)/ },
    { name: "UI code", pattern: /^@\/ui/ },
    { name: "the Server Action factory", pattern: /^@\/platform\/actions/ },
    { name: "React", pattern: /^react(?:-dom)?(?:\/|$)/ },
    { name: "translations", pattern: /^(?:next-intl|@\/i18n)/ },
  ])("never imports $name", ({ pattern }) => {
    expect(factoryImports.filter((source) => pattern.test(source))).toEqual([]);
  });

  it("uses no Next.js API other than the request type", () => {
    const nextImports = factoryImports.filter((source) =>
      /^next(?:\/|$)/.test(source),
    );

    expect([...new Set(nextImports)]).toEqual(["next/server"]);
  });

  it("never redirects or mutates a cookie", () => {
    for (const path of productionFiles) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/\bredirect\s*\(/);
      expect(source, path).not.toMatch(/\bcookies\s*\(/);
      expect(source, path).not.toMatch(/\bNextResponse\b/);
    }
  });

  it("never uses console", () => {
    for (const path of productionFiles) {
      expect(stripComments(read(path)), path).not.toMatch(/\bconsole\s*\./);
    }
  });

  it("compares no role name and reads no role from the actor", () => {
    for (const path of productionFiles) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/["'](?:admin|user)["']/);
      expect(source, path).not.toMatch(/\.roles\b/);
    }
  });

  it("delegates every capability decision to the central gate", () => {
    const factory = read(`${httpRoot}/define-route.server.ts`);

    expect(factory).toContain(
      "@/platform/auth/authorization/require-permission.server",
    );

    for (const helper of [
      "requireActor",
      "requirePermission",
      "requireAnyPermission",
      "requireAllPermissions",
    ]) {
      expect(factory).toContain(helper);
    }
  });

  it("normalizes every failure through the shared public error mapping", () => {
    const factory = read(`${httpRoot}/define-route.server.ts`);

    expect(factory).toContain("toPublicError");
    expect(factory).toContain("jsonError");
    expect(factory).toContain("jsonSuccess");
  });

  it("serializes a body in exactly one place", () => {
    const serializers = productionFiles.filter((path) =>
      /Response\.json/.test(stripComments(read(path))),
    );

    expect(serializers).toEqual([`${httpRoot}/json-response.ts`]);
  });

  it("reads a request body in exactly one place", () => {
    const readers = productionFiles.filter((path) =>
      /request\.json\(\)/.test(stripComments(read(path))),
    );

    expect(readers).toEqual([`${httpRoot}/request-input.ts`]);
  });

  it("collects a query without flattening a repeated key away", () => {
    const source = stripComments(read(`${httpRoot}/request-input.ts`));

    expect(source).not.toContain("Object.fromEntries");
    expect(source).toContain("getAll");
  });

  it("answers no 204 and builds no empty body", () => {
    for (const path of productionFiles) {
      const source = stripComments(read(path));

      expect(source, path).not.toContain("204");
      expect(source, path).not.toMatch(/new Response\s*\(\s*null/);
    }
  });
});

describe("ESLint enforcement", () => {
  let eslint: ESLint;

  beforeAll(async () => {
    eslint = new ESLint({ cwd: projectRoot });

    await eslint.lintText("export const warmUp = true;\n", {
      filePath: `${httpRoot}/warm-up.ts`,
      warnIgnored: true,
    });
  }, 20_000);

  async function lint(code: string, filePath: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, {
      filePath,
      warnIgnored: true,
    });

    if (!result) {
      throw new Error(`ESLint returned no result for ${filePath}.`);
    }

    return result.messages
      .filter(({ severity }) => severity === 2)
      .map(({ message }) => message);
  }

  it.each([
    {
      name: "the database platform",
      code: `export { database } from "@/platform/database/index.server";\n`,
    },
    {
      name: "a business module",
      code: `export { catalog } from "@/modules/catalog/index.server";\n`,
    },
    {
      name: "the Server Action factory",
      code: `export { defineAction } from "@/platform/actions/index.server";\n`,
    },
    {
      name: "ambient request headers",
      code: `export { headers } from "next/headers";\n`,
    },
  ])("refuses a factory module that imports $name", async ({ code }) => {
    expect(await lint(code, `${httpRoot}/probe.ts`)).not.toEqual([]);
  });

  it("allows the factory to use the Next.js request type", async () => {
    expect(
      await lint(
        `import type { NextRequest } from "next/server";\n\nexport type Probe = NextRequest;\n`,
        `${httpRoot}/probe-request.ts`,
      ),
    ).toEqual([]);
  });

  it.each([
    {
      name: "Prisma",
      code: `export { database } from "@/platform/database/index.server";\n`,
    },
    {
      name: "the response serializer",
      code: `export { jsonSuccess } from "@/platform/http/json-response";\n`,
    },
    {
      name: "the capability gate",
      code: `export { requirePermission } from "@/platform/auth/authorization/require-permission.server";\n`,
    },
    {
      name: "ambient request headers",
      code: `export { headers } from "next/headers";\n`,
    },
    {
      name: "an error mapping",
      code: `export function GET() {\n  try {\n    return null;\n  } catch {\n    return null;\n  }\n}\n`,
    },
    {
      name: "response construction",
      code: `export function GET() {\n  return Response.json({ data: null });\n}\n`,
    },
    {
      name: "body reading",
      code: `export async function POST(request: Request) {\n  return request.json();\n}\n`,
    },
    {
      name: "input parsing",
      code: `import * as z from "zod";\n\nexport function GET() {\n  return z.string().safeParse("value");\n}\n`,
    },
    {
      name: "a capability check",
      code: `import { requirePermission } from "@/platform/auth/authorization/require-permission.server";\n\nexport function GET() {\n  return requirePermission(null, "identity.user.list");\n}\n`,
    },
  ])("refuses a versioned adapter that performs $name", async ({ code }) => {
    expect(
      await lint(code, "src/app/api/v1/admin/contract-fixture/route.ts"),
    ).not.toEqual([]);
  });

  it("allows a versioned adapter that declares and delegates", async () => {
    const code = [
      `import { AUTHORIZATION_MODE, defineRoute } from "@/platform/http/index.server";`,
      ``,
      `export const GET = defineRoute({`,
      `  name: "fixture.probe.read",`,
      `  authorization: { mode: AUTHORIZATION_MODE.PUBLIC },`,
      `  execute: () => null,`,
      `});`,
      ``,
    ].join("\n");

    expect(
      await lint(code, "src/app/api/v1/admin/contract-fixture-ok/route.ts"),
    ).toEqual([]);
  });

  it("refuses wrapping the Better Auth catch-all in the factory", async () => {
    expect(
      await lint(
        `export { defineRoute } from "@/platform/http/index.server";\n`,
        "src/app/api/auth/contract-fixture/route.ts",
      ),
    ).not.toEqual([]);
  });
});

describe("response contract", () => {
  it("answers one success envelope carrying the correlation header", async () => {
    const response = await GET_GREETING(
      request("/api/v1/greeting?name=Ada"),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(await response.json()).toEqual({
      data: { greeting: "Hello, Ada" },
    });
  });

  it("answers a null envelope instead of an empty body", async () => {
    signIn();
    userHasPermission.mockResolvedValue({ success: true });

    const response = await POST_REVOKE(
      request("/api/v1/users/user-2/sessions/revoke", { method: "POST" }),
      context({ userId: "user-2" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: null });
    expect(readRouteExecutionLog()).toEqual(["session-revoke.execute:user-2"]);
  });

  it("authorizes before the use case runs", async () => {
    signIn();

    const response = await PATCH_ROLE(
      request("/api/v1/users/user-2/role", {
        method: "PATCH",
        body: JSON.stringify({ role: "admin" }),
      }),
      context({ userId: "user-2" }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: ERROR_CODE.FORBIDDEN },
    });
    expect(readRouteExecutionLog()).toEqual([]);
  });

  it("runs the declared audit hook only after a success", async () => {
    signIn();
    userHasPermission.mockResolvedValue({ success: true });

    const response = await PATCH_ROLE(
      request("/api/v1/users/user-2/role", {
        method: "PATCH",
        body: JSON.stringify({ role: "admin" }),
      }),
      context({ userId: "user-2" }),
    );

    expect(response.status).toBe(200);
    expect(readRouteExecutionLog()).toEqual([
      "role-set.execute",
      "role-set.audit:user-2",
    ]);
  });

  it.each([
    {
      name: "an unauthenticated caller",
      status: 401,
      code: ERROR_CODE.UNAUTHENTICATED,
      signedIn: false,
      body: JSON.stringify({ role: "admin" }),
    },
    {
      name: "an unacceptable body",
      status: 400,
      code: ERROR_CODE.VALIDATION_FAILED,
      signedIn: true,
      body: "{not json",
    },
  ])(
    "answers one error envelope for $name",
    async ({ status, code, signedIn, body }) => {
      if (signedIn) {
        signIn();
      }

      const response = await PATCH_ROLE(
        request("/api/v1/users/user-2/role", { method: "PATCH", body }),
        context({ userId: "user-2" }),
      );
      const text = await response.text();

      expect(response.status).toBe(status);
      expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
      expect(text).toBe(JSON.stringify({ error: { code } }));
      expect(text).not.toContain("message");
      expect(text).not.toContain("stack");
      expect(text).not.toContain("issues");
      expect(readRouteExecutionLog()).toEqual([]);
    },
  );
});

describe("documentation", () => {
  it("documents the Route Handler architecture", () => {
    const document = read(
      "docs/architecture/route-handler-factory.md",
    ).toLowerCase();

    for (const topic of [
      "contract",
      "authorization modes",
      "execution order",
      "typing",
      "validation",
      "error mapping",
      "hooks",
      "logging",
      "idempotency",
      "rate limit",
      "envelope",
      "request id",
      "deferred",
    ]) {
      expect(document).toContain(topic.toLowerCase());
    }
  });

  it("records the versioning and OpenAPI decision as an ADR", () => {
    const adrPath = "docs/adr/0001-versioned-api-and-openapi-strategy.md";

    expect(existsSync(resolve(projectRoot, adrPath))).toBe(true);

    const adr = read(adrPath).toLowerCase();

    for (const topic of [
      "context",
      "decision",
      "alternatives",
      "consequences",
      "rollback",
      "/api/v1",
      "zod",
      "envelope",
      "error code",
      "operation id",
      "deferred",
    ]) {
      expect(adr).toContain(topic);
    }

    expect(adr).not.toContain("openapi.yaml");
    expect(existsSync(resolve(projectRoot, "docs/api/openapi.yaml"))).toBe(
      false,
    );
  });

  it.each([
    { name: "the architecture index", path: "docs/architecture/README.md" },
    { name: "the module map", path: "docs/architecture/module-map.md" },
  ])("links the document from $name", ({ path }) => {
    expect(read(path)).toContain("route-handler-factory.md");
  });

  it("documents the implementation rules next to the code", () => {
    const document = read(`${httpRoot}/README.md`);

    expect(document).toContain("defineRoute");
    expect(document).toContain("server-only");
    expect(read("src/platform/README.md")).toContain("http/README.md");
  });
});
