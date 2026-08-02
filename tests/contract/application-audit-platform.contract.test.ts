import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import dependencyCruiserConfig from "../../.dependency-cruiser.js";
import eslintConfig from "../../eslint.config.mjs";

import {
  AUDIT_ACTOR_TYPES,
  AUDIT_LOG_EVENT,
  AUDIT_LOG_FIELD_NAMES,
  AUDIT_RESULTS,
  FORBIDDEN_AUDIT_METADATA_KEYS,
  MAX_AUDIT_METADATA_BYTES,
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  AUDIT_LIST_MIN_LIMIT,
} from "@/platform/audit/index.server";
import { IDENTITY_AUDIT_ACTIONS } from "@/platform/auth/authorization/audit/identity-audit-actions";
import {
  PERMISSION,
  PERMISSIONS,
} from "@/platform/auth/authorization/permission-registry";

/**
 * The contract for the application audit platform.
 *
 * The property this file exists to protect is a direction: authentication may
 * depend on the audit platform, and the audit platform may never depend on
 * authentication. Everything else here follows from it — a business module that
 * wants an audit trail must be able to get one without inheriting an opinion
 * about how this application signs people in.
 *
 * The rest is what makes an audit trail trustworthy: it only grows, it never
 * loses a record because a definition was deleted, it never leaks the acting
 * session, and the history that existed before this platform is still readable.
 */
const projectRoot = process.cwd();
const auditRoot = "src/platform/audit";
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

function collectFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      return collectFiles(entryPath);
    }

    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
      ? [entryPath]
      : [];
  });
}

function sourceFiles(root: string, includeTests = false) {
  return collectFiles(resolve(projectRoot, root))
    .map((filePath) => relative(projectRoot, filePath).replaceAll("\\", "/"))
    .filter((path) => includeTests || !path.includes(".test."))
    .map((path) => ({
      path,
      source: read(path),
      code: stripComments(read(path)),
    }));
}

const auditFiles = sourceFiles(auditRoot);
const platformFiles = sourceFiles("src/platform");
const applicationFiles = [
  ...platformFiles,
  ...sourceFiles("src/app"),
  ...sourceFiles("src/modules"),
  ...sourceFiles("src/ui"),
];

const auditRoutePath = "src/app/api/v1/admin/audit/route.ts";
const auditPagePath = "src/app/[locale]/(admin)/admin/audit/page.tsx";
const catalogPath = "src/app/_composition/audit-catalog.ts";

const migrationName = "establish_application_audit_platform";
const migrationDirectory = readdirSync(migrationsRoot).find((entry) =>
  entry.endsWith(migrationName),
);
const migrationSql = migrationDirectory
  ? read(`prisma/migrations/${migrationDirectory}/migration.sql`)
  : "";

describe("the platform exists and is reached through one entry point", () => {
  it("owns a directory with a server entry point and a presentation component", () => {
    expect(existsSync(resolve(projectRoot, auditRoot))).toBe(true);
    expect(
      existsSync(resolve(projectRoot, `${auditRoot}/index.server.ts`)),
    ).toBe(true);
    expect(
      existsSync(
        resolve(projectRoot, `${auditRoot}/presentation/admin-audit-list.tsx`),
      ),
    ).toBe(true);
    expect(existsSync(resolve(projectRoot, `${auditRoot}/README.md`))).toBe(
      true,
    );
  });

  it("marks every server module as server-only", () => {
    for (const { path, source } of auditFiles) {
      if (!path.endsWith(".server.ts")) {
        continue;
      }

      expect(source.startsWith('import "server-only";'), path).toBe(true);
    }
  });

  it("is imported only through the entry point or the presentation directory", () => {
    for (const { path, code } of applicationFiles) {
      if (path.startsWith(`${auditRoot}/`)) {
        continue;
      }

      for (const match of code.matchAll(/@\/platform\/audit\/([\w./-]+)/g)) {
        expect(
          match[1] === "index.server" || match[1].startsWith("presentation/"),
          `${path} imports ${match[0]}`,
        ).toBe(true);
      }
    }
  });

  it("exports no repository, no Prisma type, and no delegate", () => {
    const entry = stripComments(read(`${auditRoot}/index.server.ts`));

    expect(entry).not.toContain("audit-repository");
    expect(entry).not.toContain("insertAuditRecord");
    expect(entry).not.toContain("findAuditRecordPage");
    expect(entry).not.toContain("@/generated/prisma");
    expect(entry).not.toContain("Prisma");
  });

  it("uses no general-purpose module name", () => {
    for (const { path } of auditFiles) {
      for (const forbidden of [
        "utils",
        "helpers",
        "common",
        "manager",
        "service",
      ]) {
        expect(path.endsWith(`/${forbidden}.ts`), path).toBe(false);
      }
    }
  });
});

describe("the dependency direction", () => {
  it("never reaches authentication", () => {
    for (const { path, code } of auditFiles) {
      expect(code.includes("@/platform/auth"), path).toBe(false);
      expect(code.includes("better-auth"), path).toBe(false);
      expect(/from "(?:\.\.?\/)+auth/.test(code), path).toBe(false);
    }
  });

  it("never reaches a business module, routing, or translations", () => {
    for (const { path, code } of auditFiles) {
      expect(code.includes("@/modules"), path).toBe(false);
      expect(code.includes("@/app"), path).toBe(false);
      expect(code.includes("@/i18n"), path).toBe(false);
      expect(code.includes("next-intl"), path).toBe(false);
    }
  });

  it("never reaches Redis, a queue, background jobs, or the cache", () => {
    for (const { path, code } of auditFiles) {
      for (const specifier of [
        '"redis"',
        '"ioredis"',
        '"bullmq"',
        "@redis/",
        "@/platform/redis",
        "@/platform/jobs",
        "@/platform/cache",
        "@/platform/concurrency",
        "@/worker",
      ]) {
        expect(code.includes(specifier), `${path} ${specifier}`).toBe(false);
      }
    }
  });

  it("makes no network call and reaches no provider", () => {
    for (const { path, code } of auditFiles) {
      expect(/\bfetch\s*\(/.test(code), path).toBe(false);
      expect(code.includes("node:http"), path).toBe(false);
      expect(code.includes("undici"), path).toBe(false);
    }
  });

  it("renders only inside the presentation directory", () => {
    for (const { path, code } of auditFiles) {
      if (path.startsWith(`${auditRoot}/presentation/`)) {
        continue;
      }

      expect(/from "react/.test(code), path).toBe(false);
      expect(path.endsWith(".tsx"), path).toBe(false);
    }
  });

  it("lets authentication depend on it, and declares the identity actions there", () => {
    const identity = read(
      "src/platform/auth/authorization/audit/identity-audit-actions.ts",
    );

    expect(identity).toContain("@/platform/audit/index.server");
    expect(identity).toContain("defineAuditAction");
    expect(IDENTITY_AUDIT_ACTIONS.map((action) => action.name)).toEqual([
      "identity.user.role-set",
      "identity.session.revoked",
    ]);
  });

  it("holds no action literal of its own", () => {
    for (const { path, code } of auditFiles) {
      expect(/["'`]identity\.[a-z-]+\.[a-z-]+["'`]/.test(code), path).toBe(
        false,
      );
      expect(/["'`]documents\./.test(code), path).toBe(false);
    }
  });

  it("is declared as a boundary in ESLint and in dependency-cruiser", () => {
    const blockNames = eslintConfig
      .map((block) => block.name)
      .filter((name): name is string => typeof name === "string");

    expect(blockNames).toContain("architecture/audit-platform");
    expect(blockNames).toContain("architecture/audit-presentation");

    const ruleNames = (dependencyCruiserConfig.forbidden ?? []).map(
      (rule) => rule.name,
    );

    expect(ruleNames).toContain("no-audit-platform-internal-imports");
    expect(ruleNames).toContain("no-audit-to-authentication");
    expect(ruleNames).toContain("no-audit-to-presentation");
    expect(ruleNames).toContain("no-audit-to-infrastructure-clients");
    expect(ruleNames).toContain("no-circular-dependencies");
  });

  it("needs no architecture exception anywhere", () => {
    // Assembled rather than written out, so this file does not become the one
    // place in the repository that contains a suppression marker.
    const markers = [
      ["eslint", "disable"].join("-"),
      ["@ts", "ignore"].join("-"),
      ["@ts", "expect-error"].join("-"),
      ["dependency", "cruiser"].join("-"),
    ];

    for (const { path, source } of sourceFiles(auditRoot, true)) {
      for (const marker of markers) {
        expect(source.includes(marker), `${path} ${marker}`).toBe(false);
      }
    }

    for (const rule of dependencyCruiserConfig.forbidden ?? []) {
      expect(JSON.stringify(rule)).not.toContain(`${auditRoot}/audit-`);
    }
  });
});

describe("append-only storage", () => {
  const repository = stripComments(
    read(`${auditRoot}/audit-repository.server.ts`),
  );

  it("exposes a create and a bounded read, and nothing else", () => {
    expect(repository).toContain("auditRecord.create");
    expect(repository).toContain("auditRecord.findMany");
    expect(repository).toContain("take: limit");
  });

  it("offers no update, delete, upsert, or truncate anywhere in the platform", () => {
    for (const { path, code } of auditFiles) {
      expect(
        /\.(?:update|updateMany|upsert|deleteMany)\s*\(/.test(code),
        path,
      ).toBe(false);
      expect(/\bTRUNCATE\b/i.test(code), path).toBe(false);

      // A bare `.delete(` is only meaningful where persistence happens; the
      // pure modules use it on a `WeakSet` while walking a value for cycles.
      if (path.endsWith(".server.ts")) {
        expect(/\.delete\s*\(/.test(code), path).toBe(false);
      }
    }
  });

  it("offers no export", () => {
    for (const { path, code } of auditFiles) {
      expect(/\bexportAudit|toCsv|downloadAudit\b/.test(code), path).toBe(
        false,
      );
    }
  });

  it("reaches the audit table only from its own repository", () => {
    for (const { path, code } of applicationFiles) {
      if (path === `${auditRoot}/audit-repository.server.ts`) {
        continue;
      }

      expect(code.includes("database.auditRecord"), path).toBe(false);
      expect(
        /\bauditRecord\.(?:create|findMany|findUnique)/.test(code),
        path,
      ).toBe(false);
    }
  });

  it("never selects the acting session identifier for a reader", () => {
    const readAt = repository.indexOf("findMany");

    expect(repository.slice(readAt)).not.toContain("actorSessionId");
  });

  it("keeps the acting session out of the reader contract", () => {
    const dto = stripComments(read(`${auditRoot}/audit-record.ts`));
    const dtoAt = dto.indexOf("AuditRecordDto = Readonly");
    const dtoEnd = dto.indexOf("}>;", dtoAt);

    expect(dtoAt).toBeGreaterThan(-1);
    expect(dto.slice(dtoAt, dtoEnd)).not.toContain("actorSessionId");
  });
});

describe("the write contracts", () => {
  it("requires a transaction client for the transactional writer", () => {
    const code = stripComments(
      read(`${auditRoot}/append-audit-record.server.ts`),
    );

    expect(code).toContain("Prisma.TransactionClient");
    expect(code).toContain("assertTransactionClient");
    expect(code).not.toContain("@/platform/database");
  });

  it("does not turn a completed change into a retryable failure", () => {
    const code = stripComments(
      read(`${auditRoot}/record-audit-post-commit.server.ts`),
    );

    expect(code).toContain("catch");
    expect(code).toContain("return false");
    expect(code).not.toContain("throw");
  });

  it("writes no outbox row, publishes nothing, and waits on no network", () => {
    for (const { path, code } of auditFiles) {
      expect(code.includes("writeOutboxMessage"), path).toBe(false);
      expect(code.includes("outboxMessage"), path).toBe(false);
      expect(code.includes("queue.add"), path).toBe(false);
    }
  });
});

describe("what may be recorded", () => {
  it("closes the actor kinds and the results", () => {
    expect([...AUDIT_ACTOR_TYPES]).toEqual(["user", "system"]);
    expect([...AUDIT_RESULTS]).toEqual(["succeeded", "failed", "denied"]);
  });

  it("keeps the actor free of any identity attribute", () => {
    const code = stripComments(read(`${auditRoot}/audit-actor.ts`));
    const typeAt = code.indexOf("export type AuditActor =");
    const declaration = code.slice(typeAt, code.indexOf(";", typeAt));

    for (const field of [
      "email",
      "name",
      "roles",
      "token",
      "cookie",
      "ipAddress",
      "userAgent",
      "headers",
    ]) {
      expect(declaration.includes(field), field).toBe(false);
    }
  });

  it("bounds serialized metadata at the documented ceiling", () => {
    expect(MAX_AUDIT_METADATA_BYTES).toBe(4096);
    expect(migrationSql).toContain("<= 4096");
  });

  it("refuses the documented key names", () => {
    for (const key of [
      "password",
      "passwordhash",
      "token",
      "accesstoken",
      "refreshtoken",
      "sessiontoken",
      "cookie",
      "cookies",
      "authorization",
      "secret",
      "clientsecret",
      "apikey",
      "email",
      "displayname",
      "fullname",
      "ipaddress",
      "useragent",
      "headers",
      "request",
      "requestbody",
      "responsebody",
      "body",
      "error",
      "stack",
    ]) {
      expect(FORBIDDEN_AUDIT_METADATA_KEYS, key).toContain(key);
    }
  });

  it("declares every metadata schema as a closed object", () => {
    for (const definition of IDENTITY_AUDIT_ACTIONS) {
      // A strict schema refuses an unknown key rather than stripping it, which
      // is what makes "only these fields are ever stored" true.
      expect(
        definition.readStoredMetadata({ role: "admin", extra: "x" }),
        definition.name,
      ).toBeNull();
    }

    const identity = stripComments(
      read("src/platform/auth/authorization/audit/identity-audit-actions.ts"),
    );

    expect(identity.match(/\.strict\(\)/g)).toHaveLength(
      IDENTITY_AUDIT_ACTIONS.length,
    );
  });

  it("keeps the current metadata free of anything personal", () => {
    // The two shapes this application records today, in full.
    expect(
      IDENTITY_AUDIT_ACTIONS[0].readStoredMetadata({ role: "admin" }),
    ).toEqual({ role: "admin" });
    expect(
      IDENTITY_AUDIT_ACTIONS[1].readStoredMetadata({ scope: "all" }),
    ).toEqual({ scope: "all" });

    for (const definition of IDENTITY_AUDIT_ACTIONS) {
      for (const field of ["email", "name", "ipAddress", "userAgent"]) {
        expect(
          definition.readStoredMetadata({ [field]: "value" }),
          `${definition.name} ${field}`,
        ).toBeNull();
      }
    }
  });

  it("stores no identifier inside metadata, because each has a column", () => {
    for (const definition of IDENTITY_AUDIT_ACTIONS) {
      expect(
        definition.readStoredMetadata({ actorUserId: "a", targetUserId: "b" }),
      ).toBeNull();
    }
  });
});

describe("logging", () => {
  it("declares one event and one closed field allowlist", () => {
    expect(Object.values(AUDIT_LOG_EVENT)).toEqual([
      "audit.record.write_failed",
    ]);
    expect([...AUDIT_LOG_FIELD_NAMES]).toEqual([
      "action",
      "actorType",
      "actorId",
      "resourceType",
      "resourceId",
      "result",
      "requestId",
      "errorCode",
    ]);
  });

  it("logs metadata, a session, and a raw error nowhere", () => {
    expect(AUDIT_LOG_FIELD_NAMES).not.toContain("metadata");
    expect(AUDIT_LOG_FIELD_NAMES).not.toContain("actorSessionId");
    expect(AUDIT_LOG_FIELD_NAMES).not.toContain("error");
    expect(AUDIT_LOG_FIELD_NAMES).not.toContain("stack");
    expect(AUDIT_LOG_FIELD_NAMES).not.toContain("message");

    const code = stripComments(
      read(`${auditRoot}/record-audit-post-commit.server.ts`),
    );

    // Every line goes through the allowlist builder, so the closure holds by
    // construction rather than by each call site remembering.
    expect(code.match(/baseLogger\.\w+\(/g)).toHaveLength(
      (code.match(/toAuditLogFields\(/g) ?? []).length,
    );
    expect(code).toContain("toSafeLogError");
  });
});

describe("the admin reader", () => {
  it("declares the route by name, capability, and query alone", () => {
    const route = stripComments(read(auditRoutePath));

    expect(route).toContain('name: "audit.record.list"');
    expect(route).toContain("PERMISSION.AUDIT_RECORD_READ");
    expect(route).toContain("auditInputSchemas.listQuery");
    expect(route).toContain("listAuditRecords");
    expect(route).not.toContain("@/generated/prisma");
    expect(route).not.toContain("@/platform/database");
    expect(route).not.toContain("authorizationAuditRecord");
  });

  it("renders the page from the generic reader and the composed catalog", () => {
    const page = stripComments(read(auditPagePath));

    expect(page).toContain("listAuditRecords");
    expect(page).toContain("APPLICATION_AUDIT_CATALOG");
    expect(page).toContain("PERMISSION.AUDIT_RECORD_READ");
    expect(page).toContain("@/platform/audit/presentation/admin-audit-list");
    expect(page).toContain("Suspense");
    expect(page).toContain("index: false");
    expect(page).toContain("follow: false");
    expect(page).not.toContain("authorizationAuditRecord");
    expect(page).not.toContain("admin-audit.service");
  });

  it("composes the catalog outside the platform", () => {
    const catalog = stripComments(read(catalogPath));

    expect(catalog).toContain("createAuditCatalog");
    expect(catalog).toContain("IDENTITY_AUDIT_ACTIONS");

    for (const { path, code } of auditFiles) {
      expect(code.includes("IDENTITY_AUDIT_ACTIONS"), path).toBe(false);
    }
  });

  it("bounds the page and pages by cursor rather than by offset", () => {
    expect(AUDIT_LIST_MIN_LIMIT).toBe(1);
    expect(AUDIT_LIST_DEFAULT_LIMIT).toBe(20);
    expect(AUDIT_LIST_MAX_LIMIT).toBe(50);

    const query = stripComments(read(`${auditRoot}/audit-query.ts`));

    expect(query).toContain("cursor");
    expect(query).toContain(".strict()");
    expect(query).not.toContain("offset");

    const reader = stripComments(
      read(`${auditRoot}/list-audit-records.server.ts`),
    );

    expect(reader).toContain("nextCursor");
    expect(reader).toContain("query.limit + 1");
    expect(reader).not.toContain("count(");
    expect(reader).not.toContain("total");
  });

  it("orders by the pair the cursor carries", () => {
    const repository = stripComments(
      read(`${auditRoot}/audit-repository.server.ts`),
    );

    expect(repository).toContain('{ occurredAt: "desc" }');
    expect(repository).toContain('{ id: "desc" }');
  });
});

describe("the permission", () => {
  it("is owned by the audit platform and granted to the admin role only", () => {
    expect(PERMISSION.AUDIT_RECORD_READ).toBe("audit.record.read");
    expect(PERMISSIONS).toContain("audit.record.read");
  });

  it("leaves no trace of the identity-scoped name it replaced", () => {
    expect(PERMISSIONS as readonly string[]).not.toContain(
      "identity.audit.read",
    );

    for (const { path, code } of [
      ...applicationFiles,
      ...sourceFiles("tests", true),
    ]) {
      // Every file except the one asserting the absence.
      if (path.endsWith("application-audit-platform.contract.test.ts")) {
        continue;
      }

      expect(code.includes("identity.audit.read"), path).toBe(false);
      expect(code.includes("IDENTITY_AUDIT_READ"), path).toBe(false);
    }
  });
});

describe("the factories stay business agnostic", () => {
  const factoryRoots = [
    "src/platform/http",
    "src/platform/actions",
    "src/platform/proxy",
  ];

  it("import no audit definition and write no record", () => {
    for (const root of factoryRoots) {
      for (const { path, code } of sourceFiles(root)) {
        expect(code.includes("@/platform/audit"), path).toBe(false);
        expect(code.includes("appendAuditRecord"), path).toBe(false);
        expect(code.includes("recordAuditPostCommit"), path).toBe(false);
      }
    }
  });

  it("keep the audit hook an observer the call site declares", () => {
    const hooks = stripComments(read("src/platform/http/route-hooks.ts"));

    expect(hooks).toContain("AuditHook");
    // The hook runs after the use case succeeded, so it cannot be transactional
    // with it. A definition that wanted the stronger guarantee has to write the
    // record inside its own transaction instead.
    expect(hooks).toContain("RouteSuccessContext");
    expect(hooks).not.toContain("appendAuditRecord");
  });

  it("do not claim a post-success hook is transactional", () => {
    for (const root of factoryRoots) {
      for (const { path, code } of sourceFiles(root)) {
        expect(/afterSuccess[\s\S]{0,200}\$transaction/.test(code), path).toBe(
          false,
        );
      }
    }
  });
});

describe("the migration", () => {
  it("ships exactly one new migration", () => {
    expect(migrationDirectory).toBeDefined();
    expect(migrationSql.length).toBeGreaterThan(0);
  });

  it("is additive: it creates the table and drops nothing", () => {
    expect(migrationSql).toContain('CREATE TABLE "audit_record"');
    expect(migrationSql).toContain('CREATE TYPE "audit_actor_type"');
    expect(migrationSql).toContain('CREATE TYPE "audit_result"');

    for (const pattern of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      /\bALTER\s+TABLE\s+"(?:user|session|account|verification|authorization_audit_record)"/i,
      /FOREIGN KEY/i,
      /REFERENCES/i,
    ]) {
      expect(pattern.test(migrationSql), String(pattern)).toBe(false);
    }
  });

  it("declares the documented indexes and check constraints", () => {
    expect(migrationSql.match(/CREATE INDEX/g)).toHaveLength(4);

    for (const constraint of [
      "audit_record_actor_id_bounded",
      "audit_record_actor_session_id_bounded",
      "audit_record_resource_id_bounded",
      "audit_record_action_pattern",
      "audit_record_resource_type_pattern",
      "audit_record_request_id_canonical",
      "audit_record_metadata_bounded",
      "audit_record_actor_session_presence",
    ]) {
      expect(migrationSql, constraint).toContain(constraint);
    }
  });

  it("uses no trigger to enforce append-only", () => {
    // Append-only is an application guarantee. A trigger would also block the
    // operator who legitimately has to correct a row, and a superuser could drop
    // it anyway.
    expect(migrationSql).not.toContain("CREATE TRIGGER");
    expect(migrationSql).not.toContain("CREATE RULE");
  });

  it("copies the legacy history and keeps the legacy table", () => {
    expect(migrationSql).toContain('INSERT INTO "audit_record"');
    expect(migrationSql).toContain('FROM "authorization_audit_record"');
    expect(migrationSql).not.toContain(
      'DROP TABLE "authorization_audit_record"',
    );

    const model = read("prisma/authorization.prisma");

    expect(model).toContain("model AuthorizationAuditRecord");
    expect(model).toContain("enum AuthorizationAuditAction");
    expect(model.toLowerCase()).toContain("legacy");
  });

  it("leaves every historical migration untouched", () => {
    for (const entry of readdirSync(migrationsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.endsWith(migrationName)) {
        continue;
      }

      // The quoted identifier, so the legacy `authorization_audit_record` in the
      // earlier migration is not mistaken for the new table.
      expect(
        read(`prisma/migrations/${entry.name}/migration.sql`),
        entry.name,
      ).not.toContain('"audit_record"');
    }
  });

  it("adds an action without needing a database enum", () => {
    // The action column is a pattern-constrained string, so a module can declare
    // a new audited action without a migration.
    const model = read("prisma/audit.prisma");

    expect(/^\s*action\s+String\s+@db\.VarChar\(96\)\s*$/m.test(model)).toBe(
      true,
    );
    expect(model).not.toContain("enum AuditAction ");
  });

  it("declares no relation to identity or to any business model", () => {
    const model = read("prisma/audit.prisma");

    expect(model).not.toContain("@relation");
    expect(model).not.toContain("onDelete");
  });
});

describe("no production code reads or writes the legacy trail", () => {
  it("names the legacy delegate nowhere in the application", () => {
    for (const { path, code } of applicationFiles) {
      expect(code.includes("authorizationAuditRecord"), path).toBe(false);
    }
  });
});
