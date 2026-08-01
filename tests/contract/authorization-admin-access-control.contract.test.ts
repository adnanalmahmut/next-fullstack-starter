import { readFileSync, readdirSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import architecturePlugin, {
  ROLE_LITERALS,
} from "../../tools/eslint/architecture-plugin.mjs";

import {
  accessControl,
  adminRole,
  authorizationRoles,
  findAuthorizationRole,
  userRole,
} from "@/platform/auth/access-control";
import {
  ADMIN_ENDPOINT_RULES,
  SELF_SCOPED_ADMIN_ENDPOINTS,
} from "@/platform/auth/authorization/admin-endpoints";
import { AUDIT_ACTIONS } from "@/platform/auth/authorization/audit/audit-action";
import {
  APPLICATION_STATEMENTS,
  PERMISSIONS,
} from "@/platform/auth/authorization/permission-registry";
import {
  ADMIN_ROLE,
  AUTHORIZATION_ROLE_NAMES,
  USER_ROLE,
} from "@/platform/auth/authorization/role";
import { applicationRouteRules } from "@/platform/proxy/route-rules";
import { classifyRoute } from "@/platform/proxy/route-classifier";
import { i18nConfig } from "@/i18n/config";

const projectRoot = process.cwd();
const authorizationRoot = "src/platform/auth/authorization";
const migrationsRoot = resolve(projectRoot, "prisma/migrations");

function read(filePath: string): string {
  return readFileSync(resolve(projectRoot, filePath), "utf8");
}

/**
 * Assertions look at code, not prose. A rule described in a comment must not be
 * mistaken for a rule that is implemented.
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
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      return collectFiles(entryPath, predicate);
    }

    return predicate(entry.name) ? [entryPath] : [];
  });
}

function sourceFiles(root: string, includeTests = false) {
  return collectFiles(
    resolve(projectRoot, root),
    (name) =>
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      (includeTests || !name.includes(".test.")),
  ).map((filePath) => ({
    path: relative(projectRoot, filePath).replaceAll("\\", "/"),
    source: readFileSync(filePath, "utf8"),
    code: stripComments(readFileSync(filePath, "utf8")),
  }));
}

const authorizationFiles = sourceFiles(authorizationRoot);
const appFiles = sourceFiles("src/app");
const adminApiRoutes = [
  "src/app/api/v1/admin/users/route.ts",
  "src/app/api/v1/admin/users/[userId]/route.ts",
  "src/app/api/v1/admin/users/[userId]/role/route.ts",
  "src/app/api/v1/admin/users/[userId]/sessions/revoke/route.ts",
  "src/app/api/v1/admin/audit/route.ts",
];
const adminPages = [
  "src/app/[locale]/(admin)/admin/layout.tsx",
  "src/app/[locale]/(admin)/admin/page.tsx",
  "src/app/[locale]/(admin)/admin/users/page.tsx",
  "src/app/[locale]/(admin)/admin/audit/page.tsx",
];

const migrationName = "establish_authorization_admin_access_control";
const migrationDirectory = readdirSync(migrationsRoot).find((entry) =>
  entry.endsWith(migrationName),
);
const migrationSql = migrationDirectory
  ? read(`prisma/migrations/${migrationDirectory}/migration.sql`)
  : "";

describe("permission registry", () => {
  it("is the only place a permission literal is written", () => {
    const registryPath = `${authorizationRoot}/permission-registry.ts`;

    for (const { path, code } of [...authorizationFiles, ...appFiles]) {
      if (path === registryPath) {
        continue;
      }

      for (const permission of PERMISSIONS) {
        expect(code.includes(`"${permission}"`), `${path} ${permission}`).toBe(
          false,
        );
        expect(code.includes(`'${permission}'`), `${path} ${permission}`).toBe(
          false,
        );
      }
    }
  });

  it("declares no wildcard permission", () => {
    for (const permission of PERMISSIONS) {
      expect(permission).not.toContain("*");
    }

    for (const resource of Object.keys(APPLICATION_STATEMENTS)) {
      expect(resource).not.toContain("*");
    }
  });

  it("builds no permission name from request input", () => {
    for (const { path, code } of [...authorizationFiles, ...appFiles]) {
      expect(/`identity\.[^`]*\$\{/.test(code), path).toBe(false);
      expect(/"identity\." *\+/.test(code), path).toBe(false);
    }
  });
});

describe("access control", () => {
  it("keeps a single Admin plugin registration", () => {
    const authServer = stripComments(read("src/platform/auth/auth.server.ts"));

    expect(authServer.match(/admin\(\{/g)).toHaveLength(1);
    expect(authServer).toContain("ac: accessControl");
    expect(authServer).toContain("roles: authorizationRoles");
  });

  it("combines the plugin statements with the application statements", () => {
    expect(Object.keys(accessControl.statements).sort()).toEqual([
      "identity.admin",
      "identity.audit",
      "identity.session",
      "identity.user",
      "session",
      "user",
    ]);
  });

  it("declares exactly two roles", () => {
    expect(Object.keys(authorizationRoles).sort()).toEqual(["admin", "user"]);
    expect(AUTHORIZATION_ROLE_NAMES).toEqual([USER_ROLE, ADMIN_ROLE]);
    expect(findAuthorizationRole(USER_ROLE)).toBe(userRole);
    expect(findAuthorizationRole(ADMIN_ROLE)).toBe(adminRole);
    expect(findAuthorizationRole("superadmin")).toBeUndefined();
    expect(findAuthorizationRole("constructor")).toBeUndefined();
  });

  it("grants the user role nothing at all", () => {
    expect(userRole.statements).toEqual({
      user: [],
      session: [],
      "identity.admin": [],
      "identity.user": [],
      "identity.session": [],
      "identity.audit": [],
    });
  });

  it("grants the admin role least privilege", () => {
    expect(adminRole.statements).toEqual({
      user: ["list", "get", "set-role"],
      session: ["list", "revoke"],
      "identity.admin": ["access"],
      "identity.user": ["list", "read", "set-role"],
      "identity.session": ["revoke"],
      "identity.audit": ["read"],
    });
  });

  it("withholds every Better Auth operation outside the supported set", () => {
    const withheld = {
      user: [
        "create",
        "update",
        "delete",
        "ban",
        "impersonate",
        "impersonate-admins",
        "set-password",
        "set-email",
      ],
      session: ["delete"],
    } as const;

    for (const [resource, actions] of Object.entries(withheld)) {
      for (const action of actions) {
        expect(
          adminRole.authorize({ [resource]: [action] }).success,
          `${resource}.${action}`,
        ).toBe(false);
      }
    }
  });

  it("grants every declared application capability to the admin role", () => {
    for (const permission of PERMISSIONS) {
      const [module, resource, action] = permission.split(".");

      expect(
        adminRole.authorize({ [`${module}.${resource}`]: [action] }).success,
        permission,
      ).toBe(true);
    }
  });

  it("configures no identifier allowlist and no impersonation escape", () => {
    const authServer = stripComments(read("src/platform/auth/auth.server.ts"));

    expect(authServer).not.toContain("adminUserIds");
    expect(authServer).not.toContain("allowImpersonatingAdmins");

    for (const { path, code } of authorizationFiles) {
      expect(code.includes("adminUserIds"), path).toBe(false);
      expect(code.includes("impersonat"), path).toBe(false);
      expect(code.includes("adminClient"), path).toBe(false);
    }
  });

  it("keeps the role literals of the lint rule in step with the role module", () => {
    expect([...ROLE_LITERALS].sort()).toEqual(
      [...AUTHORIZATION_ROLE_NAMES].sort(),
    );
    expect(Object.keys(architecturePlugin.rules)).toContain(
      "no-role-comparison",
    );
  });
});

describe("authorization boundaries", () => {
  it("marks every server-only authorization module", () => {
    for (const { path, source } of authorizationFiles) {
      if (!path.endsWith(".server.ts")) {
        continue;
      }

      expect(source.startsWith('import "server-only";'), path).toBe(true);
    }
  });

  it("keeps the pure modules free of framework and server-only imports", () => {
    const pure = [
      `${authorizationRoot}/permission-registry.ts`,
      `${authorizationRoot}/role.ts`,
      `${authorizationRoot}/actor.ts`,
      `${authorizationRoot}/capability.ts`,
      `${authorizationRoot}/admin-endpoints.ts`,
      `${authorizationRoot}/policies/set-role.policy.ts`,
      `${authorizationRoot}/policies/revoke-sessions.policy.ts`,
      `${authorizationRoot}/audit/audit-action.ts`,
      `${authorizationRoot}/audit/audit-record.ts`,
    ];

    for (const path of pure) {
      const code = stripComments(read(path));

      expect(code.includes('from "next'), path).toBe(false);
      expect(code.includes('"server-only"'), path).toBe(false);
      expect(code.includes("@/platform/database"), path).toBe(false);
      expect(code.includes("@/generated/prisma"), path).toBe(false);
    }
  });

  it("keeps the actor free of a token, an address, or a permission graph", () => {
    const code = stripComments(read(`${authorizationRoot}/actor.ts`));

    for (const field of [
      "token",
      "cookie",
      "ipAddress",
      "userAgent",
      "password",
      "banned",
      "permissions",
    ]) {
      expect(code.includes(field), field).toBe(false);
    }
  });

  it("reaches the database only from the two repositories", () => {
    const allowed = new Set([
      `${authorizationRoot}/audit/audit-repository.server.ts`,
      `${authorizationRoot}/identity-read.repository.server.ts`,
    ]);

    for (const { path, code } of authorizationFiles) {
      if (allowed.has(path)) {
        continue;
      }

      expect(code.includes("@/platform/database"), path).toBe(false);
      expect(code.includes("@/generated/prisma"), path).toBe(false);
    }
  });

  it("keeps the proxy out of authorization", () => {
    for (const { path, code } of sourceFiles("src/platform/proxy")) {
      expect(code.includes("@/platform/auth"), path).toBe(false);
      expect(code.includes("getSession"), path).toBe(false);
      expect(code.includes("requirePermission"), path).toBe(false);
      expect(code.includes("Actor"), path).toBe(false);
    }

    expect(stripComments(read("src/proxy.ts"))).not.toContain("auth");
  });

  it("keeps the client boundary free of authorization modules", () => {
    for (const { path, code } of sourceFiles("src/platform/auth")) {
      if (!code.includes('"use client"')) {
        continue;
      }

      expect(code.includes("authorization/"), path).toBe(false);
      expect(code.includes("auth.server"), path).toBe(false);
      expect(code.includes("session.server"), path).toBe(false);
    }
  });

  it("separates the policies from the capability evaluator", () => {
    for (const policy of ["set-role", "revoke-sessions"]) {
      const code = stripComments(
        read(`${authorizationRoot}/policies/${policy}.policy.ts`),
      );

      expect(code).not.toContain("hasCapabilities");
      expect(code).not.toContain("requirePermission");
      expect(code).not.toContain("userHasPermission");
      expect(code).not.toContain("permission-registry");
    }

    const evaluator = stripComments(read(`${authorizationRoot}/capability.ts`));

    expect(evaluator).not.toContain("policies/");
  });

  it("asks Better Auth for the capability decision", () => {
    const code = stripComments(
      read(`${authorizationRoot}/require-permission.server.ts`),
    );

    expect(code).toContain("auth.api.userHasPermission");
    expect(code).toContain("userId: actor.userId");
    expect(code).not.toContain("database");
  });

  it("exports the throwing helpers and keeps the boolean form internal", () => {
    const code = read(`${authorizationRoot}/require-permission.server.ts`);

    for (const helper of [
      "export async function requirePermission",
      "export async function requireAnyPermission",
      "export async function requireAllPermissions",
    ]) {
      expect(code).toContain(helper);
    }

    expect(code).toContain("async function hasPermission");
    expect(code).not.toContain("export async function hasPermission");
  });
});

describe("administration API", () => {
  it("ships every declared route", () => {
    for (const path of adminApiRoutes) {
      expect(existsSync(resolve(projectRoot, path)), path).toBe(true);
    }
  });

  it("authorizes independently in every route", () => {
    for (const path of adminApiRoutes) {
      const code = stripComments(read(path));

      // The route declares its requirement and the factory enforces it. A
      // declaration is what makes the check impossible to forget: a definition
      // without an `authorization` mode does not compile.
      expect(code.includes("defineRoute("), path).toBe(true);
      expect(code.includes("authorization:"), path).toBe(true);
      expect(code.includes("AUTHORIZATION_MODE.PERMISSION"), path).toBe(true);
      expect(code.includes("PERMISSION."), path).toBe(true);
    }
  });

  it("names a registry capability rather than a literal", () => {
    for (const path of adminApiRoutes) {
      const code = stripComments(read(path));

      expect(/permission:\s*PERMISSION\.[A-Z_]+/.test(code), path).toBe(true);
      expect(/permission:\s*["']/.test(code), path).toBe(false);
    }
  });

  it("requires the capability before it reads the target identifier", () => {
    // The order is a property of the factory, not of any one route: it resolves
    // the actor and requires the capability before `execute` runs, so a target
    // identifier is never loaded for a caller who may not have it.
    const factory = stripComments(
      read("src/platform/http/define-route.server.ts"),
    );
    const body = factory.slice(
      factory.indexOf("return async function runRoute"),
    );
    const authorizeAt = body.indexOf("authorizeActor(");
    const executeAt = body.indexOf("definition.execute(");

    expect(authorizeAt).toBeGreaterThanOrEqual(0);
    expect(executeAt).toBeGreaterThan(authorizeAt);
  });

  it("keeps persistence, role comparison, and provider errors out of the routes", () => {
    for (const path of adminApiRoutes) {
      const code = stripComments(read(path));

      expect(code.includes("@/platform/database"), path).toBe(false);
      expect(code.includes("@/generated/prisma"), path).toBe(false);
      expect(code.includes("better-auth"), path).toBe(false);
      expect(/\brole\s*[=!]==/.test(code), path).toBe(false);
      expect(code.includes("console."), path).toBe(false);
    }
  });

  it("answers through the shared error contract", () => {
    // Serialization moved into the factory, so a route neither builds a response
    // nor maps an error; proving it never does is the stronger assertion.
    for (const path of adminApiRoutes) {
      const code = stripComments(read(path));

      expect(code.includes("jsonError"), path).toBe(false);
      expect(code.includes("jsonSuccess"), path).toBe(false);
      expect(/\btry\s*\{/.test(code), path).toBe(false);
      expect(code.includes("Response"), path).toBe(false);
    }

    const factory = stripComments(
      read("src/platform/http/define-route.server.ts"),
    );

    expect(factory.includes("jsonError")).toBe(true);
    expect(factory.includes("jsonSuccess")).toBe(true);
  });

  it("validates its own input", () => {
    for (const path of adminApiRoutes) {
      const code = stripComments(read(path));

      expect(code.includes("input:"), path).toBe(true);
      expect(/adminInputSchemas\.\w+/.test(code), path).toBe(true);
      // The schema is declared; the factory is what parses it.
      expect(/\.(?:safe)?[pP]arse(?:Async)?\(/.test(code), path).toBe(false);
    }
  });

  it("logs no body and no headers", () => {
    for (const path of adminApiRoutes) {
      const code = stripComments(read(path));

      expect(/log\w*\([^)]*body/i.test(code), path).toBe(false);
      expect(/log\w*\([^)]*headers/i.test(code), path).toBe(false);
    }
  });
});

describe("administration area", () => {
  it("ships every declared page", () => {
    for (const path of adminPages) {
      expect(existsSync(resolve(projectRoot, path)), path).toBe(true);
    }
  });

  it("authorizes on the server in the layout and in every page", () => {
    for (const path of adminPages) {
      const code = stripComments(read(path));

      expect(code.includes("resolveAuthorization"), path).toBe(true);
      expect(code.includes("PERMISSION."), path).toBe(true);
      expect(code.includes("useSession"), path).toBe(false);
      expect(code.includes('"use client"'), path).toBe(false);
      expect(/\brole\s*[=!]==/.test(code), path).toBe(false);
    }
  });

  it("redirects an unauthenticated visitor from the layout", () => {
    const code = stripComments(read(adminPages[0]));

    expect(code).toContain("UNAUTHENTICATED");
    expect(code).toContain("redirect(");
    expect(code).toContain("RETURN_TO_PARAM");
  });

  it("keeps every administration page out of search results", () => {
    for (const path of adminPages.slice(1)) {
      const code = stripComments(read(path));

      expect(code.includes("index: false"), path).toBe(true);
      expect(code.includes("follow: false"), path).toBe(true);
    }
  });

  it("hard-codes no user-facing copy", () => {
    for (const path of [...adminPages, `${authorizationRoot}/presentation`]) {
      for (const { path: filePath, code } of path.endsWith(".tsx")
        ? [{ path, code: stripComments(read(path)) }]
        : sourceFiles(path)) {
        expect(/>[A-Za-z]{4,}[^<{]*</.test(code), filePath).toBe(false);
        expect(/[؀-ۿ]/.test(code), filePath).toBe(false);
      }
    }
  });

  it("uses no physical left or right utility", () => {
    for (const { path, code } of sourceFiles(
      `${authorizationRoot}/presentation`,
    )) {
      expect(
        /\b(?:ml|mr|pl|pr|left|right|text-left|text-right)-/.test(code),
        path,
      ).toBe(false);
    }
  });
});

describe("proxy classification", () => {
  it("declares the administration subtree", () => {
    expect(
      applicationRouteRules.find((rule) => rule.pathname === "/admin"),
    ).toEqual({
      pathname: "/admin",
      area: "admin",
      match: "subtree",
      localized: true,
    });
  });

  it.each([
    { pathname: "/ar/admin", area: "admin" },
    { pathname: "/en/admin", area: "admin" },
    { pathname: "/ar/admin/users", area: "admin" },
    { pathname: "/en/admin/audit", area: "admin" },
    { pathname: "/ar/administrator", area: "unknown" },
    { pathname: "/en/administer", area: "unknown" },
    { pathname: "/ar/admin-tools", area: "unknown" },
    { pathname: "/api/v1/admin/users", area: "api" },
    { pathname: "/api/v1/admin/audit", area: "api" },
  ])("classifies $pathname as $area", ({ pathname, area }) => {
    expect(
      classifyRoute({
        pathname,
        locales: [...i18nConfig.locales],
        rules: applicationRouteRules,
      }),
    ).toBe(area);
  });
});

describe("audit trail", () => {
  it("declares exactly the two audited mutations", () => {
    expect(AUDIT_ACTIONS).toEqual([
      "identity.user.role-set",
      "identity.session.revoked",
    ]);
  });

  it("ties every audited mutation to a governed endpoint", () => {
    expect(
      ADMIN_ENDPOINT_RULES.filter((rule) => rule.audit !== null).map(
        (rule) => rule.audit,
      ),
    ).toEqual(AUDIT_ACTIONS);
  });

  it("audits no read", () => {
    for (const rule of ADMIN_ENDPOINT_RULES) {
      if (rule.path.includes("list") || rule.path.includes("get")) {
        expect(rule.audit, rule.path).toBeNull();
      }
    }

    expect(SELF_SCOPED_ADMIN_ENDPOINTS).not.toContain("/admin/set-role");
  });

  it("exposes no update or delete operation", () => {
    const repository = read(
      `${authorizationRoot}/audit/audit-repository.server.ts`,
    );
    const code = stripComments(repository);

    expect(code).toContain("authorizationAuditRecord.create");
    expect(code).toContain("authorizationAuditRecord.findMany");
    expect(code).not.toContain("update");
    expect(code).not.toContain("delete");
    expect(code).not.toContain("upsert");
    expect(code).toContain("take: limit");
  });

  it("never selects the acting session identifier for a reader", () => {
    const code = stripComments(
      read(`${authorizationRoot}/audit/audit-repository.server.ts`),
    );
    const readAt = code.indexOf("findMany");

    expect(code.slice(readAt)).not.toContain("actorSessionId");
  });

  it("stores no sensitive field", () => {
    const model = read("prisma/authorization.prisma");
    const code = model
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("///"))
      .join("\n");

    for (const field of [
      "password",
      "token",
      "cookie",
      "authorizationHeader",
      "userAgent",
      "ipAddress",
      "email",
      "name ",
      "stack",
      "body",
    ]) {
      expect(code.toLowerCase().includes(field.toLowerCase()), field).toBe(
        false,
      );
    }
  });

  it("keeps the record independent of the identity tables", () => {
    const model = read("prisma/authorization.prisma");

    expect(model).not.toContain("@relation");
    expect(model).not.toContain("onDelete");
    expect(model).toContain("model AuthorizationAuditRecord");
  });

  it("does not fail a completed operation when the record cannot be stored", () => {
    const code = stripComments(
      read(`${authorizationRoot}/audit/record-audit.server.ts`),
    );

    expect(code).toContain("catch");
    expect(code).toContain("AUDIT_WRITE_FAILED");
    expect(code).not.toContain("throw");
  });
});

describe("migration", () => {
  it("ships one additive migration", () => {
    expect(migrationDirectory).toBeDefined();
    expect(migrationSql.length).toBeGreaterThan(0);
  });

  it("contains no destructive statement", () => {
    for (const pattern of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bALTER\s+TABLE\s+"(?:user|session|account|verification)"/i,
      /\bCREATE\s+EXTENSION\b/i,
      /\bUPDATE\b/i,
      /\bINSERT\b/i,
    ]) {
      expect(pattern.test(migrationSql), String(pattern)).toBe(false);
    }
  });

  it("creates the table, the action type, and the documented indexes", () => {
    expect(migrationSql).toContain('CREATE TABLE "authorization_audit_record"');
    expect(migrationSql).toContain('CREATE TYPE "authorization_audit_action"');
    expect(migrationSql).toContain("'identity.user.role-set'");
    expect(migrationSql).toContain("'identity.session.revoked'");
    expect(migrationSql.match(/CREATE INDEX/g)).toHaveLength(3);
    expect(migrationSql).toContain(
      'CREATE INDEX "authorization_audit_record_occurredAt_idx"',
    );
    expect(migrationSql).toContain(
      'CREATE INDEX "authorization_audit_record_actorUserId_occurredAt_idx"',
    );
    expect(migrationSql).toContain(
      'CREATE INDEX "authorization_audit_record_targetUserId_occurredAt_idx"',
    );
  });

  it("adds no foreign key", () => {
    expect(migrationSql).not.toContain("FOREIGN KEY");
    expect(migrationSql).not.toContain("ADD CONSTRAINT");
    expect(migrationSql).not.toContain("REFERENCES");
  });

  it("leaves the earlier migration untouched", () => {
    const earlier = readdirSync(migrationsRoot).find((entry) =>
      entry.endsWith("establish_authentication_foundation"),
    );

    expect(earlier).toBeDefined();
    expect(read(`prisma/migrations/${earlier}/migration.sql`)).not.toContain(
      "authorization_audit_record",
    );
  });
});

describe("scope", () => {
  it("adds no bootstrap or role-management surface", () => {
    const paths = collectFiles(resolve(projectRoot, "src/app"), () => true).map(
      (filePath) => relative(projectRoot, filePath).replaceAll("\\", "/"),
    );

    for (const fragment of [
      "bootstrap",
      "promote",
      "elevate",
      "seed-admin",
      "register",
    ]) {
      expect(
        paths.filter((path) => path.includes(fragment)),
        fragment,
      ).toEqual([]);
    }
  });

  it("adds no cache, queue, or client authorization store", () => {
    for (const { path, code } of [...authorizationFiles, ...appFiles]) {
      expect(code.includes("localStorage"), path).toBe(false);
      expect(code.includes("sessionStorage"), path).toBe(false);
      expect(code.includes("ioredis"), path).toBe(false);
      expect(code.includes("bullmq"), path).toBe(false);
      expect(code.includes("jsonwebtoken"), path).toBe(false);
    }
  });

  it("adds no dependency for authorization", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const installed = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };

    // Better Auth stays the source of truth for roles and permissions, at the
    // same pinned version.
    expect(manifest.dependencies["better-auth"]).toBe("1.6.25");
    expect(manifest.dependencies["@better-auth/prisma-adapter"]).toBe("1.6.25");

    for (const packageName of [
      "ioredis",
      "redis",
      "bullmq",
      "jsonwebtoken",
      "jose",
      "casbin",
      "accesscontrol",
      "@casl/ability",
      "next-auth",
    ]) {
      expect(installed, packageName).not.toHaveProperty(packageName);
    }
  });

  it("suppresses no lint or type error and skips no test", () => {
    const ownPath =
      "tests/contract/authorization-admin-access-control.contract.test.ts";

    for (const { path, source } of [
      ...sourceFiles(authorizationRoot, true),
      ...appFiles,
      ...sourceFiles("tests/contract", true),
      ...sourceFiles("tests/integration", true),
    ]) {
      // This file names the markers it looks for, so it excludes itself.
      if (path === ownPath) {
        continue;
      }

      for (const marker of [
        "eslint-disable",
        "@ts-ignore",
        "@ts-expect-error",
        ".skip(",
        ".todo(",
        ".only(",
      ]) {
        expect(source.includes(marker), `${path} ${marker}`).toBe(false);
      }
    }
  });
});

describe("localization", () => {
  it("declares the same keys in both locales", () => {
    function keysOf(value: unknown, prefix = ""): string[] {
      if (typeof value !== "object" || value === null) {
        return [prefix];
      }

      return Object.entries(value).flatMap(([key, nested]) =>
        keysOf(nested, prefix ? `${prefix}.${key}` : key),
      );
    }

    const arabic = JSON.parse(read("messages/ar.json")) as Record<
      string,
      unknown
    >;
    const english = JSON.parse(read("messages/en.json")) as Record<
      string,
      unknown
    >;

    for (const namespace of ["Authorization", "Admin"]) {
      expect(keysOf(arabic[namespace]).sort()).toEqual(
        keysOf(english[namespace]).sort(),
      );
    }
  });

  it("covers the administration area copy", () => {
    const english = JSON.parse(read("messages/en.json")) as {
      Admin: Record<string, unknown>;
      Authorization: Record<string, unknown>;
    };

    expect(Object.keys(english.Admin).sort()).toEqual([
      "audit",
      "dashboard",
      "navigationLabel",
      "sections",
      "users",
    ]);
    expect(Object.keys(english.Authorization).sort()).toEqual([
      "forbiddenDescription",
      "forbiddenTitle",
      "roles",
    ]);
  });

  it("translates no permission identifier and no error code", () => {
    for (const locale of ["ar", "en"]) {
      const messages = read(`messages/${locale}.json`);

      for (const permission of PERMISSIONS) {
        expect(messages.includes(permission), `${locale} ${permission}`).toBe(
          false,
        );
      }

      for (const code of ["FORBIDDEN", "UNAUTHENTICATED", "CONFLICT"]) {
        expect(messages.includes(code), `${locale} ${code}`).toBe(false);
      }
    }
  });
});

describe("documentation", () => {
  it("documents the authorization architecture", () => {
    const document = read(
      "docs/architecture/authorization-admin-access-control.md",
    );

    for (const topic of [
      "Permission naming",
      "capability",
      "resource policy",
      "Actor",
      "least-privilege",
      "audit",
      "migration",
      "provisioning",
      "Proxy",
      "Deferred",
    ]) {
      expect(document.toLowerCase()).toContain(topic.toLowerCase());
    }
  });

  it("links the document from the architecture index", () => {
    expect(read("docs/architecture/README.md")).toContain(
      "authorization-admin-access-control.md",
    );
  });
});
