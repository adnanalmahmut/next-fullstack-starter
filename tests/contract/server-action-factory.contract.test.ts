import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ESLint } from "eslint";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ERROR_CODE } from "@/shared/errors/error-code";

/**
 * The Server Action boundary contract.
 *
 * Two kinds of assertion appear here. The source assertions prove the adapter
 * cannot reach a database, a business module, or a transport, because that is a
 * property of the code rather than of any single call. The behavioural assertions
 * run real Action definitions from the fixture and prove the guarantees a caller
 * depends on: authorization precedes the use case, every failure resolves to an
 * `ActionResult`, and nothing is invalidated before a success.
 */
const projectRoot = process.cwd();
const actionsRoot = "src/platform/actions";
const fixturePath = "tests/fixtures/server-action.fixture.ts";

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

const productionFiles = readdirSync(resolve(projectRoot, actionsRoot))
  .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
  .map((name) => `${actionsRoot}/${name}`);

const serverOnlyFiles = productionFiles.filter((path) =>
  path.includes(".server."),
);

const factoryImports = productionFiles.flatMap((path) =>
  readImports(read(path)),
);

/** Behavioural setup. Only the Better Auth edge and the cache APIs are replaced. */
const getSession = vi.fn();
const userHasPermission = vi.fn();
const revalidatePath = vi.fn();
const revalidateTag = vi.fn();

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@/platform/auth/auth.server", () => ({
  auth: {
    api: {
      getSession: (options: unknown) => getSession(options),
      userHasPermission: (options: unknown) => userHasPermission(options),
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string, type?: string) => revalidatePath(path, type),
  revalidateTag: (tag: string, profile: unknown) => revalidateTag(tag, profile),
}));

const {
  clearActionExecutionLog,
  readActionExecutionLog,
  readGreetingAction,
  setFixtureRoleAction,
} = await import("../fixtures/server-action.fixture");

beforeEach(async () => {
  getSession.mockReset();
  userHasPermission.mockReset();
  revalidatePath.mockReset();
  revalidateTag.mockReset();
  getSession.mockResolvedValue(null);
  userHasPermission.mockResolvedValue({ success: false });
  await clearActionExecutionLog();
});

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

describe("factory boundaries", () => {
  it("marks every server module with the server-only guard", () => {
    expect(serverOnlyFiles.length).toBeGreaterThan(0);

    for (const path of serverOnlyFiles) {
      expect(read(path).startsWith('import "server-only";')).toBe(true);
    }
  });

  it("keeps the controlled entry point server-only", () => {
    expect(read(`${actionsRoot}/index.server.ts`)).toContain(
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
    { name: "UI code", pattern: /^@\/ui/ },
    { name: "the HTTP response contract", pattern: /^@\/platform\/http/ },
    { name: "React", pattern: /^react(?:-dom)?(?:\/|$)/ },
    { name: "translations", pattern: /^(?:next-intl|@\/i18n)/ },
  ])("never imports $name", ({ pattern }) => {
    expect(factoryImports.filter((source) => pattern.test(source))).toEqual([]);
  });

  it("uses no Next.js API at all", () => {
    // The factory used to call the Next.js cache APIs itself. Invalidation now
    // belongs to one shared system in `@/platform/cache`, so an Action and a
    // Route Handler purge the same tags through the same code, and the Action
    // factory is left with no transport dependency of any kind.
    const nextImports = factoryImports.filter((source) =>
      /^next(?:\/|$)/.test(source),
    );

    expect(nextImports).toEqual([]);
  });

  it("delegates invalidation to the shared cache platform", () => {
    expect(
      factoryImports.filter((source) => source.startsWith("@/platform/cache")),
    ).toContain("@/platform/cache/cache-invalidation.server");
  });

  it("never redirects, mutates a cookie, or writes a response", () => {
    for (const path of productionFiles) {
      const source = stripComments(read(path));

      expect(source).not.toMatch(/\bredirect\s*\(/);
      expect(source).not.toMatch(/\bcookies\s*\(/);
      expect(source).not.toMatch(/\bNextResponse\b/);
      expect(source).not.toMatch(/\bnew Response\b/);
    }
  });

  it("never uses console", () => {
    for (const path of productionFiles) {
      expect(stripComments(read(path))).not.toMatch(/\bconsole\s*\./);
    }
  });

  it("compares no role name and reads no role from the actor", () => {
    for (const path of productionFiles) {
      const source = stripComments(read(path));

      expect(source).not.toMatch(/["'](?:admin|user)["']/);
      expect(source).not.toMatch(/\.roles\b/);
    }
  });

  it("delegates every capability decision to the central gate", () => {
    const factory = read(`${actionsRoot}/define-action.server.ts`);

    expect(factory).toContain(
      "@/platform/auth/authorization/require-permission.server",
    );
    expect(factory).toContain("requirePermission");
    expect(factory).toContain("requireAnyPermission");
    expect(factory).toContain("requireAllPermissions");
    expect(factory).toContain("requireActor");
  });

  it("normalizes every failure through the shared public error mapping", () => {
    const factory = read(`${actionsRoot}/define-action.server.ts`);

    expect(factory).toContain("toPublicError");
    expect(factory).toContain("actionFailure");
    expect(factory).toContain("actionSuccess");
  });
});

describe("ESLint enforcement", () => {
  let eslint: ESLint;

  beforeAll(async () => {
    eslint = new ESLint({ cwd: projectRoot });

    await eslint.lintText("export const warmUp = true;\n", {
      filePath: `${actionsRoot}/warm-up.ts`,
      warnIgnored: true,
    });
  }, 20_000);

  async function lint(code: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, {
      filePath: `${actionsRoot}/probe.ts`,
      warnIgnored: true,
    });

    if (!result) {
      throw new Error("ESLint returned no result for the Action probe.");
    }

    return result.messages
      .filter(
        ({ ruleId, severity }) =>
          severity === 2 &&
          (ruleId === "no-restricted-imports" || ruleId === "no-console"),
      )
      .map(({ message }) => message);
  }

  it.each([
    {
      name: "the database platform",
      code: `import { database } from "@/platform/database/index.server";\n\nexport const value = database;\n`,
    },
    {
      name: "a business module",
      code: `import { catalog } from "@/modules/catalog/index.server";\n\nexport const value = catalog;\n`,
    },
    {
      name: "a redirect",
      code: `import { redirect } from "next/navigation";\n\nexport const value = redirect;\n`,
    },
    {
      name: "cookie mutation",
      code: `import { cookies } from "next/headers";\n\nexport const value = cookies;\n`,
    },
    {
      name: "the HTTP response contract",
      code: `import { HTTP_STATUS_BY_ERROR_CODE } from "@/platform/http/http-response";\n\nexport const value = HTTP_STATUS_BY_ERROR_CODE;\n`,
    },
  ])("refuses an Action module that imports $name", async ({ code }) => {
    expect(await lint(code)).not.toEqual([]);
  });

  it("refuses console in an Action module", async () => {
    const messages = await lint(
      `export function report(): void {\n  console.log("diagnostic");\n}\n`,
    );

    expect(messages).not.toEqual([]);
  });

  it("allows the Next.js cache APIs", async () => {
    const messages = await lint(
      `import { revalidatePath } from "next/cache";\n\nexport const value = revalidatePath;\n`,
    );

    expect(messages).toEqual([]);
  });
});

describe("action definitions", () => {
  it("marks the definition file with the use server directive", () => {
    expect(read(fixturePath).startsWith('"use server";')).toBe(true);
  });

  it("exports only async functions from the definition file", () => {
    const source = stripComments(read(fixturePath));
    const exportedFunctions = Array.from(
      source.matchAll(/^export\s+(?:async\s+function|const)\s+(\w+)/gm),
      (match) => match[1],
    );

    expect(exportedFunctions.length).toBeGreaterThan(0);
    expect(source).not.toMatch(/^export\s+function\s/m);
    expect(source).not.toMatch(/^export\s+(?:type|interface|class)\s/m);
  });

  it("builds every Action through the factory", () => {
    const source = stripComments(read(fixturePath));
    const definitionCount = source.match(/defineAction\(/g)?.length ?? 0;

    expect(definitionCount).toBeGreaterThan(1);
    expect(readImports(source)).toContain("@/platform/actions/index.server");
    expect(source).toContain("defineAction");
  });

  it.each([
    { name: "validation", pattern: /safeParse|\.parse\(/ },
    { name: "actor resolution", pattern: /getCurrentActor|getSession/ },
    { name: "a capability check", pattern: /require(?:Any|All)?Permission/ },
    { name: "error mapping", pattern: /toPublicError|catch\s*\(/ },
    { name: "result construction", pattern: /action(?:Success|Failure)\(/ },
    { name: "a cache call", pattern: /revalidate(?:Path|Tag)\(/ },
  ])("never restates $name in a definition", ({ pattern }) => {
    expect(stripComments(read(fixturePath))).not.toMatch(pattern);
  });

  it("declares a permission from the registry rather than a literal", () => {
    const source = stripComments(read(fixturePath));

    expect(source).toContain("PERMISSION.IDENTITY_USER_SET_ROLE");
    expect(source).not.toMatch(/permission:\s*["']/);
  });
});

describe("action guarantees", () => {
  it("resolves a public Action without a session", async () => {
    await expect(readGreetingAction({ name: "Ada" })).resolves.toEqual({
      ok: true,
      data: { greeting: "Hello, Ada" },
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("authorizes before the use case runs", async () => {
    signIn();

    await expect(setFixtureRoleAction({ userId: "user-2" })).resolves.toEqual({
      ok: false,
      error: { code: ERROR_CODE.FORBIDDEN },
    });
    expect(userHasPermission).toHaveBeenCalledOnce();
    expect(await readActionExecutionLog()).toEqual([]);
  });

  it("reaches the use case once the capability is granted", async () => {
    signIn();
    userHasPermission.mockResolvedValue({ success: true });

    await expect(setFixtureRoleAction({ userId: "user-2" })).resolves.toEqual({
      ok: true,
      data: { targetUserId: "user-2", actorUserId: "user-1" },
    });
    expect(await readActionExecutionLog()).toEqual([
      "role-set.execute",
      "role-set.audit:user-2",
    ]);
  });

  it.each([
    {
      name: "an invalid input",
      call: () => setFixtureRoleAction({ userId: "" }),
      code: ERROR_CODE.VALIDATION_FAILED,
    },
    {
      name: "a missing actor",
      call: () => setFixtureRoleAction({ userId: "user-2" }),
      code: ERROR_CODE.UNAUTHENTICATED,
    },
  ])("resolves an ActionResult for $name", async ({ call, code }) => {
    const result = await call();

    expect(result).toEqual({ ok: false, error: { code } });
    expect(Object.keys(result)).toEqual(["ok", "error"]);
    expect(await readActionExecutionLog()).toEqual([]);
  });

  it("invalidates the declared path only after the use case succeeded", async () => {
    signIn();

    await setFixtureRoleAction({ userId: "user-2" });

    expect(revalidatePath).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();

    userHasPermission.mockResolvedValue({ success: true });

    await setFixtureRoleAction({ userId: "user-2" });

    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith(
      "/admin/users",
      undefined,
    );
  });

  it("exposes only a code on a failure and no internal detail", async () => {
    const result = await setFixtureRoleAction({ userId: "" });
    const serialized = JSON.stringify(result);

    expect(serialized).toBe(
      JSON.stringify({ ok: false, error: { code: "VALIDATION_FAILED" } }),
    );
    expect(serialized).not.toContain("message");
    expect(serialized).not.toContain("stack");
    expect(serialized).not.toContain("issues");
  });
});

describe("documentation", () => {
  it("documents the Server Action architecture", () => {
    const document = read(
      "docs/architecture/server-action-factory.md",
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
      "audit",
      "cache invalidation",
      "use server",
      "not transactional",
      "deferred",
    ]) {
      expect(document).toContain(topic.toLowerCase());
    }
  });

  it.each([
    { name: "the architecture index", path: "docs/architecture/README.md" },
    { name: "the module map", path: "docs/architecture/module-map.md" },
  ])("links the document from $name", ({ path }) => {
    expect(read(path)).toContain("server-action-factory.md");
  });

  it("documents the implementation rules next to the code", () => {
    const document = read(`${actionsRoot}/README.md`);

    expect(document).toContain('"use server"');
    expect(document).toContain("server-only");
    expect(read("src/platform/README.md")).toContain("actions/README.md");
  });
});
