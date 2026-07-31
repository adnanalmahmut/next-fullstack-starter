import { readFileSync, readdirSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isAuthSessionDiagnosticEnabled } from "@/app/api/diagnostics/auth-session/auth-session-access";
import {
  ADMIN_ROLE,
  ADMIN_ROLES,
  DEFAULT_ROLE,
  USER_ROLE,
  accessControl,
  authorizationRoles,
} from "@/platform/auth/access-control";
import { isEmailRegistrationEnabled } from "@/platform/auth/registration-policy";
import { applicationRouteRules } from "@/platform/proxy/route-rules";

const projectRoot = process.cwd();
const authRoot = "src/platform/auth";
const migrationsRoot = resolve(projectRoot, "prisma/migrations");

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

const authSourceFiles = collectFiles(
  resolve(projectRoot, authRoot),
  (name) =>
    (name.endsWith(".ts") || name.endsWith(".tsx")) &&
    !name.endsWith(".unit.test.ts"),
).map((filePath) => ({
  path: relative(projectRoot, filePath).replaceAll("\\", "/"),
  source: readFileSync(filePath, "utf8"),
  code: stripComments(readFileSync(filePath, "utf8")),
}));

const authServerSource = read(`${authRoot}/auth.server.ts`);
const authServerCode = stripComments(authServerSource);
const authClientCode = stripComments(read(`${authRoot}/auth-client.ts`));
const sessionCode = stripComments(read(`${authRoot}/session.server.ts`));
const apiRouteSource = read("src/app/api/auth/[...all]/route.ts");

const migrationDirectories = readdirSync(migrationsRoot, {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const migrationSql = migrationDirectories
  .map((name) =>
    readFileSync(resolve(migrationsRoot, name, "migration.sql"), "utf8"),
  )
  .join("\n");

const packageJson = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};

describe("authentication architecture boundaries", () => {
  it("marks the Better Auth server entry as server-only", () => {
    expect(authServerSource).toMatch(/^import "server-only";/);
    expect(read(`${authRoot}/session.server.ts`)).toMatch(
      /^import "server-only";/,
    );
  });

  it("keeps the client entry free of server dependencies", () => {
    for (const forbidden of [
      "server-only",
      "./auth.server",
      "@/platform/auth/auth.server",
      "@/platform/database",
      "@/config/env/index.server",
      "@prisma/client",
    ]) {
      expect(authClientCode).not.toContain(forbidden);
    }
  });

  it("reuses the shared database instance instead of creating a client", () => {
    expect(authServerCode).toContain(
      'import { database } from "@/platform/database/index.server"',
    );

    for (const { path, code } of authSourceFiles) {
      expect(code.includes("new PrismaClient"), path).toBe(false);
      expect(code.includes("PrismaPg"), path).toBe(false);
    }
  });

  it("reads configuration through the validated environment only", () => {
    for (const { path, code } of authSourceFiles) {
      expect(code.includes("process.env"), path).toBe(false);
    }

    expect(authServerCode).toContain("serverEnv.BETTER_AUTH_SECRET");
  });

  it("keeps presentation out of the session and server modules", () => {
    for (const source of [authServerCode, sessionCode]) {
      expect(source).not.toContain("@/ui/");
      expect(source).not.toContain("react");
    }
  });

  it("keeps the auth platform independent of business modules", () => {
    for (const { path, code } of authSourceFiles) {
      expect(code.includes("@/modules"), path).toBe(false);
    }
  });

  it("stores no credential in browser storage and defines no custom token format", () => {
    for (const { path, code } of authSourceFiles) {
      expect(code.includes("localStorage"), path).toBe(false);
      expect(code.includes("sessionStorage"), path).toBe(false);
      expect(code.includes("jsonwebtoken"), path).toBe(false);
      expect(/\bjwt\b/i.test(code), path).toBe(false);
    }
  });

  it("keeps the proxy pipeline independent of authentication", () => {
    const proxyFiles = collectFiles(
      resolve(projectRoot, "src/platform/proxy"),
      (name) => name.endsWith(".ts") && !name.endsWith(".unit.test.ts"),
    ).map((filePath) => ({
      path: relative(projectRoot, filePath),
      code: stripComments(readFileSync(filePath, "utf8")),
    }));

    for (const { path, code } of [
      ...proxyFiles,
      { path: "src/proxy.ts", code: stripComments(read("src/proxy.ts")) },
    ]) {
      expect(code.includes("better-auth"), path).toBe(false);
      expect(code.includes("platform/auth"), path).toBe(false);
      expect(code.includes("platform/database"), path).toBe(false);
    }
  });
});

describe("Better Auth configuration", () => {
  it("enables email and password authentication", () => {
    expect(authServerCode).toMatch(
      /emailAndPassword:\s*\{[\s\S]*enabled: true/,
    );
  });

  it("derives sign-up availability from the registration policy", () => {
    expect(authServerCode).toContain(
      "disableSignUp: !isEmailRegistrationEnabled(serverEnv.APP_ENV)",
    );
    expect(isEmailRegistrationEnabled("development")).toBe(true);
    expect(isEmailRegistrationEnabled("test")).toBe(true);
    expect(isEmailRegistrationEnabled("staging")).toBe(false);
    expect(isEmailRegistrationEnabled("production")).toBe(false);
  });

  it("does not require email verification while no email provider exists", () => {
    expect(authServerCode).toContain("requireEmailVerification: false");
  });

  it("keeps sessions database-backed with no cookie cache", () => {
    expect(authServerCode).toMatch(/cookieCache:\s*\{\s*enabled: false/);
    expect(authServerCode).not.toContain("secondaryStorage");
    expect(authServerCode).not.toContain("storeSessionInDatabase");
  });

  it("declares an explicit session lifetime policy", () => {
    expect(authServerCode).toContain("expiresIn: SESSION_EXPIRES_IN_SECONDS");
    expect(authServerCode).toContain("updateAge: SESSION_UPDATE_AGE_SECONDS");
    expect(authServerCode).toContain(
      "const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7",
    );
    expect(authServerCode).toContain(
      "const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24",
    );
  });

  it("uses the Prisma adapter for PostgreSQL", () => {
    expect(authServerCode).toContain(
      'import { prismaAdapter } from "@better-auth/prisma-adapter"',
    );
    expect(authServerCode).toMatch(
      /prismaAdapter\(database,\s*\{[\s\S]*provider: "postgresql"/,
    );
  });

  it("declares the base URL and trusted origins explicitly", () => {
    expect(authServerCode).toContain("baseURL: publicEnv.NEXT_PUBLIC_APP_URL");
    expect(authServerCode).toContain(
      "trustedOrigins: [publicEnv.NEXT_PUBLIC_APP_URL]",
    );
  });

  it("configures no social provider and no experimental option", () => {
    for (const forbidden of [
      "socialProviders",
      "experimental",
      "databaseHooks",
      "nextCookies",
    ]) {
      expect(authServerCode).not.toContain(forbidden);
    }
  });

  it("keeps the default password hashing implementation", () => {
    expect(authServerCode).not.toMatch(/password:\s*\{/);
    expect(authServerCode).not.toContain("scrypt");
    expect(authServerCode).not.toContain("bcrypt");
    expect(authServerCode).not.toContain("argon2");
  });

  it("hard-codes no secret", () => {
    for (const { path, code } of authSourceFiles) {
      expect(/secret:\s*"/.test(code), path).toBe(false);
      expect(code.includes("BETTER_AUTH_SECRET ??"), path).toBe(false);
    }
  });
});

describe("admin plugin foundation", () => {
  it("declares exactly the two baseline roles", () => {
    expect(USER_ROLE).toBe("user");
    expect(ADMIN_ROLE).toBe("admin");
    expect(DEFAULT_ROLE).toBe("user");
    expect(ADMIN_ROLES).toEqual(["admin"]);
    expect(Object.keys(authorizationRoles).sort()).toEqual(["admin", "user"]);
  });

  it("uses the plugin statements without inventing business resources", () => {
    expect(Object.keys(accessControl.statements).sort()).toEqual([
      "session",
      "user",
    ]);
  });

  it("grants the default role no administrative capability", () => {
    const userRole = authorizationRoles[USER_ROLE];

    expect(userRole?.statements).toEqual({
      user: [],
      session: [],
    });
  });

  it("wires the plugin through the centralized access control", () => {
    expect(authServerCode).toContain("admin({");
    expect(authServerCode).toContain("ac: accessControl");
    expect(authServerCode).toContain("roles: authorizationRoles");
    expect(authServerCode).toContain("defaultRole: DEFAULT_ROLE");
    expect(authServerCode).toContain("adminRoles: ADMIN_ROLES");
  });

  it("adds no administrative interface or user management", () => {
    const appFiles = collectFiles(
      resolve(projectRoot, "src/app"),
      (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
    ).map((filePath) => relative(projectRoot, filePath).replaceAll("\\", "/"));

    expect(appFiles.filter((path) => path.includes("/admin"))).toEqual([]);

    for (const { path, code } of authSourceFiles) {
      expect(code.includes("adminClient"), path).toBe(false);
      expect(code.includes("impersonate"), path).toBe(false);
    }
  });

  it("spreads no permission check into application pages", () => {
    const pageFiles = collectFiles(
      resolve(projectRoot, "src/app"),
      (name) => name === "page.tsx",
    ).map((filePath) => ({
      path: relative(projectRoot, filePath).replaceAll("\\", "/"),
      code: stripComments(readFileSync(filePath, "utf8")),
    }));

    for (const { path, code } of pageFiles) {
      expect(/\brole\s*===/.test(code), path).toBe(false);
      expect(code.includes("hasPermission"), path).toBe(false);
      expect(code.includes("requirePermission"), path).toBe(false);
    }
  });
});

describe("authentication routes", () => {
  it("mounts Better Auth on a thin catch-all handler", () => {
    expect(
      existsSync(resolve(projectRoot, "src/app/api/auth/[...all]/route.ts")),
    ).toBe(true);
    expect(apiRouteSource).toContain(
      'import { toNextJsHandler } from "better-auth/next-js"',
    );
    expect(apiRouteSource).toContain(
      "export const { GET, POST } = toNextJsHandler(auth.handler)",
    );

    const code = stripComments(apiRouteSource);

    expect(code).not.toContain("await request");
    expect(code).not.toContain("database");
    expect(code).not.toContain("getSession");
    expect(code.trimEnd().split("\n").length).toBeLessThanOrEqual(12);
  });

  it("classifies the new routes without adding an unimplemented one", () => {
    const byPathname = new Map(
      applicationRouteRules.map((rule) => [rule.pathname, rule]),
    );

    expect(byPathname.get("/login")).toEqual({
      pathname: "/login",
      area: "auth",
      match: "exact",
      localized: true,
    });
    expect(byPathname.get("/account")).toEqual({
      pathname: "/account",
      area: "front-office",
      match: "exact",
      localized: true,
    });
    expect(byPathname.has("/register")).toBe(false);
  });

  it("ships no registration page", () => {
    const appFiles = collectFiles(
      resolve(projectRoot, "src/app"),
      () => true,
    ).map((filePath) => relative(projectRoot, filePath).replaceAll("\\", "/"));

    expect(appFiles.filter((path) => path.includes("register"))).toEqual([]);
    expect(appFiles.filter((path) => path.includes("sign-up"))).toEqual([]);
  });

  it("gates the session diagnostic inside the handler", () => {
    expect(isAuthSessionDiagnosticEnabled("development")).toBe(true);
    expect(isAuthSessionDiagnosticEnabled("test")).toBe(true);
    expect(isAuthSessionDiagnosticEnabled("staging")).toBe(false);
    expect(isAuthSessionDiagnosticEnabled("production")).toBe(false);

    const routeSource = read("src/app/api/diagnostics/auth-session/route.ts");

    expect(routeSource).toContain("isAuthSessionDiagnosticEnabled");
    expect(routeSource).toContain("status: 404");
    expect(routeSource).toContain("getSessionFromHeaders");

    for (const forbidden of [
      "token",
      "cookie",
      "authorization",
      "ipAddress",
      "userAgent",
      "banned",
    ]) {
      expect(stripComments(routeSource)).not.toContain(forbidden);
    }
  });

  it("protects the account page and the session read on the server", () => {
    const accountPage = read(
      "src/app/[locale]/(front-office)/account/page.tsx",
    );
    const loginPage = read("src/app/[locale]/(auth)/login/page.tsx");

    for (const source of [accountPage, loginPage]) {
      expect(source).toContain("getCurrentSession()");
      expect(source).not.toContain("useSession");
      expect(source).not.toContain('"use client"');
      expect(source).not.toContain("@/platform/database");
    }

    expect(accountPage).toContain("redirect(");
    expect(accountPage).toContain("RETURN_TO_PARAM");
    expect(loginPage).toContain("resolveSafeReturnTo(");
  });

  it("keeps raw Prisma access out of pages and route handlers", () => {
    const appFiles = collectFiles(
      resolve(projectRoot, "src/app"),
      (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
    ).map((filePath) => ({
      path: relative(projectRoot, filePath).replaceAll("\\", "/"),
      code: stripComments(readFileSync(filePath, "utf8")),
    }));

    for (const { path, code } of appFiles) {
      expect(code.includes("@/platform/database"), path).toBe(false);
      expect(code.includes("@/generated/prisma"), path).toBe(false);
    }
  });
});

describe("authentication migration", () => {
  it("contains exactly one reviewed migration", () => {
    expect(migrationDirectories).toEqual([
      "20260731201511_establish_authentication_foundation",
    ]);
  });

  it("uses no destructive statement", () => {
    for (const pattern of [
      /drop\s+table/i,
      /drop\s+column/i,
      /drop\s+constraint/i,
      /truncate/i,
      /^\s*delete\s+from/im,
      /create\s+extension/i,
    ]) {
      expect(pattern.test(migrationSql)).toBe(false);
    }
  });

  it("creates the Better Auth tables", () => {
    for (const table of ["user", "session", "account", "verification"]) {
      expect(migrationSql).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it("creates the expected constraints and indexes", () => {
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "user_email_key" ON "user"("email")',
    );
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "session_token_key" ON "session"("token")',
    );
    expect(migrationSql).toContain(
      'CREATE INDEX "session_userId_idx" ON "session"("userId")',
    );
    expect(migrationSql).toContain(
      'CREATE INDEX "account_userId_idx" ON "account"("userId")',
    );
  });

  it("cascades session and account rows from their user", () => {
    for (const table of ["session", "account"]) {
      expect(migrationSql).toMatch(
        new RegExp(
          `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_userId_fkey"[\\s\\S]*?ON DELETE CASCADE`,
        ),
      );
    }
  });

  it("keeps administrative fields on the schema", () => {
    for (const column of ["role", "banned", "banReason", "banExpires"]) {
      expect(migrationSql).toContain(`"${column}"`);
    }

    expect(migrationSql).toContain('"impersonatedBy"');
  });

  it("stores the credential password on the account only", () => {
    const userTable = migrationSql.slice(
      migrationSql.indexOf('CREATE TABLE "user"'),
      migrationSql.indexOf('CREATE TABLE "session"'),
    );

    expect(userTable).not.toContain('"password"');
    expect(migrationSql).toMatch(
      /CREATE TABLE "account"[\s\S]*?"password" TEXT/,
    );
  });

  it("embeds no secret or fixture credential", () => {
    expect(migrationSql).not.toMatch(/password\s*=\s*'/i);
    expect(migrationSql).not.toMatch(/insert\s+into/i);
  });
});

describe("authentication localization", () => {
  it("keeps the Arabic and English namespaces aligned", () => {
    const arabic = JSON.parse(read("messages/ar.json")) as Record<
      string,
      unknown
    >;
    const english = JSON.parse(read("messages/en.json")) as Record<
      string,
      unknown
    >;

    function keyPaths(value: unknown, prefix = ""): string[] {
      if (typeof value !== "object" || value === null) {
        return [prefix];
      }

      return Object.entries(value).flatMap(([key, nested]) =>
        keyPaths(nested, prefix ? `${prefix}.${key}` : key),
      );
    }

    expect(keyPaths(arabic["Auth"]).sort()).toEqual(
      keyPaths(english["Auth"]).sort(),
    );
    expect(keyPaths(arabic["Auth"]).length).toBeGreaterThan(0);
  });

  it("renders authentication copy through translation keys", () => {
    for (const filePath of [
      "src/app/[locale]/(auth)/login/page.tsx",
      "src/app/[locale]/(front-office)/account/page.tsx",
    ]) {
      const source = read(filePath);

      expect(source).toContain("getTranslations({");
      expect(source).toMatch(/namespace: "Auth\./);
    }
  });

  it("keeps user-facing copy out of the auth platform internals", () => {
    for (const filePath of [
      `${authRoot}/auth.server.ts`,
      `${authRoot}/session.server.ts`,
      `${authRoot}/access-control.ts`,
      `${authRoot}/registration-policy.ts`,
      "src/app/api/auth/[...all]/route.ts",
    ]) {
      expect(stripComments(read(filePath))).not.toMatch(
        /next-intl|useTranslations|getTranslations/,
      );
    }
  });
});

describe("authentication dependencies", () => {
  it("pins Better Auth and its adapter to the same exact version", () => {
    expect(packageJson.dependencies["better-auth"]).toBe("1.6.25");
    expect(packageJson.dependencies["@better-auth/prisma-adapter"]).toBe(
      "1.6.25",
    );
  });

  it("uses no prerelease version", () => {
    for (const name of ["better-auth", "@better-auth/prisma-adapter"]) {
      expect(packageJson.dependencies[name]).not.toMatch(
        /alpha|beta|rc|canary|next/i,
      );
    }
  });

  it("adds no competing authentication or session package", () => {
    const installed = Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    });

    for (const forbidden of [
      "next-auth",
      "@auth/core",
      "lucia",
      "passport",
      "bcrypt",
      "bcryptjs",
      "argon2",
      "jsonwebtoken",
      "jose",
      "cookie",
      "express-session",
      "iron-session",
    ]) {
      expect(installed).not.toContain(forbidden);
    }
  });

  it("keeps the Better Auth CLI out of project dependencies", () => {
    const installed = Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    });

    expect(installed).not.toContain("auth");
    expect(installed).not.toContain("@better-auth/cli");
  });

  it("exposes explicit migration scripts", () => {
    expect(packageJson.scripts["db:migrate:deploy"]).toBe(
      "prisma migrate deploy",
    );
    expect(packageJson.scripts["db:migrate:status"]).toBe(
      "prisma migrate status",
    );
    expect(packageJson.scripts["db:migrate:dev"]).toBe("prisma migrate dev");

    for (const script of Object.values(packageJson.scripts)) {
      expect(script).not.toContain("db push");
      expect(script).not.toContain("migrate reset");
    }
  });
});
