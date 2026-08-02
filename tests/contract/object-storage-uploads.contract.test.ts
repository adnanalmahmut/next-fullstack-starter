import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import dependencyCruiserConfig from "../../.dependency-cruiser.js";
import eslintConfig from "../../eslint.config.mjs";

import {
  STORAGE_HEALTH_STATUS,
  STORAGE_INSPECTION_RESULTS,
  STORAGE_LOG_EVENT,
  STORAGE_LOG_FIELD_NAMES,
  STORAGE_OBJECT_STATUSES,
  UPLOAD_INSPECTION,
  UPLOAD_INTENT_STATUSES,
} from "@/platform/storage/index.server";

/**
 * The contract for secure object storage and uploads.
 *
 * The property this file exists to protect is that storage stays a *capability*
 * rather than a feature: the application must build, boot, and pass its whole
 * suite with no bucket, no endpoint, and no credentials anywhere, and a project
 * that will never store a file must be able to delete one directory and lose
 * nothing else.
 *
 * The rest is what makes a direct browser upload safe. Bytes never pass through
 * Next.js. A client can write exactly one key, once, within one size, and can
 * never address the object a module will later read. Nothing is ever public.
 * And the values that would compromise all of that — a signed URL, a finalize
 * token, a bucket name, a storage key — are kept out of logs, DTOs, and errors
 * by construction rather than by review.
 */
const projectRoot = process.cwd();
const storageRoot = "src/platform/storage";
const providerRoot = "src/platform/storage/provider";
const migrationsRoot = resolve(projectRoot, "prisma/migrations");

function read(filePath: string): string {
  return readFileSync(resolve(projectRoot, filePath), "utf8");
}

/**
 * Assertions look at code, not prose. A rule described in a comment must not be
 * mistaken for a rule that is implemented — and this area's comments name every
 * forbidden value at least once.
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

/**
 * Every file a scan looks at, minus this one.
 *
 * This file names each forbidden marker at least once — it has to, to search
 * for it — so including itself would make every scan below fail on its own
 * text.
 */
const selfPath = "tests/contract/object-storage-uploads.contract.test.ts";

function scannedFiles(root: string, includeTests = false) {
  return sourceFiles(root, includeTests).filter(
    (entry) => entry.path !== selfPath,
  );
}

const storageFiles = sourceFiles(storageRoot);
const platformFiles = sourceFiles("src/platform");
const applicationFiles = [
  ...platformFiles,
  ...sourceFiles("src/app"),
  ...sourceFiles("src/modules"),
  ...sourceFiles("src/ui"),
  ...sourceFiles("src/worker"),
];

const migrationName = "establish_secure_object_storage_and_uploads";
const migrationDirectory = readdirSync(migrationsRoot).find((entry) =>
  entry.endsWith(migrationName),
);
const migrationSql = migrationDirectory
  ? read(`prisma/migrations/${migrationDirectory}/migration.sql`)
  : "";

/**
 * The forbidden rules, read as the path-based shape they all use here.
 *
 * dependency-cruiser types a rule as a union whose other members have no `to`
 * path, and none of this repository's rules is one of those.
 */
type PathRule = Readonly<{
  name?: string;
  severity?: string;
  from?: { path?: unknown; pathNot?: unknown };
  to?: { path?: unknown };
}>;

const forbiddenRules = (dependencyCruiserConfig.forbidden ??
  []) as readonly PathRule[];

function eslintBlock(name: string) {
  return eslintConfig.find((entry) => entry.name === name);
}

function restrictedPatterns(name: string): string[] {
  const block = eslintBlock(name) as
    { rules?: Record<string, unknown> } | undefined;
  const rule = block?.rules?.["no-restricted-imports"] as
    [string, { patterns?: Array<{ regex?: string }> }] | undefined;

  return (rule?.[1].patterns ?? [])
    .map((pattern) => pattern.regex ?? "")
    .filter(Boolean);
}

describe("the platform exists and is reached through one entry point", () => {
  it("owns a directory with a server entry point and a README", () => {
    expect(existsSync(resolve(projectRoot, storageRoot))).toBe(true);
    expect(
      existsSync(resolve(projectRoot, `${storageRoot}/index.server.ts`)),
    ).toBe(true);
    expect(existsSync(resolve(projectRoot, `${storageRoot}/README.md`))).toBe(
      true,
    );
  });

  it("has no client entry point", () => {
    // Nothing here is safe in a browser bundle, and the upload the browser
    // performs is a plain form POST to a URL the server signed — it needs no
    // client library at all.
    expect(
      existsSync(resolve(projectRoot, `${storageRoot}/index.client.ts`)),
    ).toBe(false);
  });

  it("marks every server module as server-only", () => {
    for (const { path, source } of storageFiles) {
      if (!path.endsWith(".server.ts")) {
        continue;
      }

      expect(source.startsWith('import "server-only";'), path).toBe(true);
    }
  });

  it("is imported only through the entry point", () => {
    for (const { path, code } of applicationFiles) {
      if (path.startsWith(`${storageRoot}/`)) {
        continue;
      }

      const internal = code.match(
        /@\/platform\/storage\/(?!index\.server)[\w./-]+/g,
      );

      expect(internal ?? [], path).toEqual([]);
    }
  });

  it("keeps the entry point free of the repository, the client, and the keys", () => {
    const entry = stripComments(read(`${storageRoot}/index.server.ts`));

    for (const forbidden of [
      "storage-repository.server",
      "s3-storage-provider.server",
      "storage-key",
      "checksum",
      "finalize-token",
      "@aws-sdk",
      "S3Client",
    ]) {
      expect(entry, forbidden).not.toContain(forbidden);
    }
  });

  it("exports the operations a calling module needs and no more", () => {
    const entry = read(`${storageRoot}/index.server.ts`);

    for (const operation of [
      "defineUploadPolicy",
      "createUploadIntent",
      "finalizeUploadIntent",
      "createStorageDownloadUrl",
      "getStorageObjectMetadata",
      "cleanupExpiredUploadIntents",
      "checkStorageHealth",
      "isStorageEnabled",
      "closeStorageClient",
    ]) {
      expect(entry, operation).toContain(operation);
    }
  });
});

describe("the dependency direction", () => {
  const areas = [
    ["@/platform/auth", /@\/platform\/auth(?:\/|")/],
    ["@/platform/audit", /@\/platform\/audit(?:\/|")/],
    ["@/platform/redis", /@\/platform\/redis(?:\/|")/],
    ["@/platform/cache", /@\/platform\/cache(?:\/|")/],
    ["@/platform/jobs", /@\/platform\/jobs(?:\/|")/],
    ["@/platform/concurrency", /@\/platform\/concurrency(?:\/|")/],
    ["@/worker", /@\/worker(?:\/|")/],
    ["@/modules", /@\/modules(?:\/|")/],
    ["@/app", /@\/app(?:\/|")/],
    ["@/ui", /@\/ui(?:\/|")/],
    ["@/i18n", /@\/i18n(?:\/|")/],
    ["react", /from "react(?:-dom)?(?:\/[\w-]+)?"/],
    ["next-intl", /from "next-intl(?:\/[\w-]+)?"/],
    ["bullmq or ioredis", /from "(?:bullmq|ioredis)"/],
  ] as const;

  it.each(areas)("never reaches %s", (_label, pattern) => {
    for (const { path, code } of storageFiles) {
      expect(pattern.test(code), path).toBe(false);
    }
  });
});

describe("the provider driver is contained", () => {
  it("keeps every AWS SDK import inside the provider directory", () => {
    for (const { path, code } of sourceFiles("src")) {
      if (path.startsWith(`${providerRoot}/`)) {
        continue;
      }

      expect(code.includes("@aws-sdk/"), path).toBe(false);
    }
  });

  it("uses no MinIO SDK anywhere", () => {
    // MinIO speaks the S3 protocol, so a second client library would be a
    // second code path for one wire format.
    const manifest = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies)).not.toContain("minio");
    expect(Object.keys(manifest.devDependencies)).not.toContain("minio");

    for (const { path, code } of [
      ...scannedFiles("src"),
      ...scannedFiles("tests", true),
    ]) {
      expect(code.includes('from "minio"'), path).toBe(false);
    }
  });

  it("pins every storage dependency to an exact version", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };

    for (const [name, version] of Object.entries(manifest.dependencies)) {
      if (!name.startsWith("@aws-sdk/")) {
        continue;
      }

      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("does not export the S3 client or a credential type", () => {
    const entry = read(`${storageRoot}/index.server.ts`);

    for (const forbidden of [
      "S3Client",
      "StorageCredentials",
      "accessKeyId",
      "secretAccessKey",
    ]) {
      expect(entry, forbidden).not.toContain(forbidden);
    }
  });

  it("names no AWS type in the provider port", () => {
    const port = stripComments(read(`${providerRoot}/storage-provider.ts`));

    // `checkBucket` is one of the port's own operations, so "bucket" as a word
    // is expected here. What must be absent is an AWS type, and the bucket as a
    // *parameter*: the bucket is configuration, and an operation that could name
    // one could name a different one.
    expect(port).not.toContain("@aws-sdk");
    expect(port).not.toContain("S3Client");
    expect(port).not.toContain("AWS");
    expect(port).not.toMatch(/\bbucket:/);
  });
});

describe("nothing is ever public", () => {
  it("sends no ACL and no public grant", () => {
    for (const { path, code } of [
      ...scannedFiles("src"),
      ...scannedFiles("tests", true),
    ]) {
      expect(/public-read/.test(code), path).toBe(false);
      expect(/PutObjectAcl/.test(code), path).toBe(false);
      expect(/x-amz-acl/.test(code), path).toBe(false);
      expect(/\bACL:/.test(code), path).toBe(false);
    }
  });

  it("grants no anonymous access in the Compose definition", () => {
    const compose = read("compose.storage.yaml");

    // The operative forms, not the word: `mc anonymous set` and a bucket policy
    // are the two ways a MinIO bucket becomes readable without a signature, and
    // neither appears.
    expect(compose).not.toContain("public-read");
    expect(compose).not.toContain("anonymous set");
    expect(compose).not.toContain("MINIO_ANONYMOUS");
    expect(compose).not.toContain("policy set");
  });

  it("issues no presigned upload for a final object key", () => {
    const provider = stripComments(
      read(`${providerRoot}/s3-storage-provider.server.ts`),
    );
    const useCase = stripComments(
      read(`${storageRoot}/create-upload-intent.server.ts`),
    );

    // The one call site that signs an upload passes the staging key, and the
    // key layout keeps the two namespaces apart.
    expect(useCase).toContain("key: stagingKey");
    expect(useCase).not.toContain("key: objectKey");
    expect(provider).toContain("createPresignedPost");
  });
});

describe("the client never chooses a key", () => {
  it("generates every key server-side from randomness", () => {
    const keys = stripComments(read(`${storageRoot}/storage-key.ts`));

    expect(keys).toContain("randomBytes");
    expect(keys).toContain("KEY_RANDOM_BYTES");
  });

  it("accepts no key, filename, bucket, or ACL in a file declaration", () => {
    const declaration = stripComments(
      read(`${storageRoot}/file-declaration.ts`),
    );

    for (const forbidden of [
      "filename",
      "fileName",
      "path",
      "objectKey",
      "stagingKey",
      "bucket",
      "acl",
      "userId",
      "sessionId",
    ]) {
      expect(declaration.includes(forbidden), forbidden).toBe(false);
    }
  });

  it("refuses a traversal or a separator inside a key segment", () => {
    const keys = stripComments(read(`${storageRoot}/storage-key.ts`));

    expect(keys).toContain('includes("..")');
    expect(keys).toContain('includes("\\\\")');
  });
});

describe("what may leave the platform", () => {
  it("never puts a signed URL, a token, or a key into a log line", () => {
    expect([...STORAGE_LOG_FIELD_NAMES]).toEqual([
      "intentId",
      "objectId",
      "policyName",
      "outcome",
      "reasonCode",
      "requestId",
      "errorCode",
      "durationMs",
      "deleted",
      "examined",
    ]);

    for (const forbidden of [
      "url",
      "signedUrl",
      "fields",
      "token",
      "tokenHash",
      "bucket",
      "endpoint",
      "key",
      "filename",
      "checksum",
      "stack",
    ]) {
      expect([...STORAGE_LOG_FIELD_NAMES], forbidden).not.toContain(forbidden);
    }
  });

  it("logs only through the allowlist builder", () => {
    for (const { path, code } of storageFiles) {
      const calls = code.match(/logger\.(?:info|warn|error|debug)\(/g) ?? [];

      if (calls.length === 0) {
        continue;
      }

      expect(code, path).toContain("toStorageLogFields");
    }
  });

  it("uses no console anywhere in the platform", () => {
    for (const { path, code } of storageFiles) {
      expect(/console\.(?:log|error|warn|info|debug)/.test(code), path).toBe(
        false,
      );
    }
  });

  it("lets no raw provider error out of the adapter", () => {
    for (const { path, code } of storageFiles) {
      if (path.startsWith(`${providerRoot}/`)) {
        continue;
      }

      // Above the adapter the only failure type is the platform's own, and the
      // error contracts it maps to.
      expect(code.includes("S3ServiceException"), path).toBe(false);
      expect(code.includes("$metadata"), path).toBe(false);
    }
  });

  it("carries only a status out of the health contract", () => {
    expect(Object.values(STORAGE_HEALTH_STATUS)).toEqual([
      "disabled",
      "healthy",
      "unavailable",
      "misconfigured",
    ]);

    const health = stripComments(read(`${storageRoot}/health.server.ts`));

    expect(health).not.toContain("bucket");
    expect(health).not.toContain("endpoint");
  });
});

describe("data access is contained", () => {
  it("touches a storage delegate only in the repository", () => {
    for (const { path, code } of sourceFiles("src")) {
      if (path === `${storageRoot}/storage-repository.server.ts`) {
        continue;
      }

      expect(
        /(?:database|tx|client)\.storage(?:Object|UploadIntent)\b/.test(code),
        path,
      ).toBe(false);
    }
  });

  it("keeps the provider out of the file that opens transactions", () => {
    // The structural form of "no provider request inside a database
    // transaction": the only file that calls `$transaction` cannot reach the
    // adapter, so it cannot hold row locks across an HTTP round trip.
    const repository = stripComments(
      read(`${storageRoot}/storage-repository.server.ts`),
    );

    expect(repository).toContain("$transaction");
    expect(repository).not.toContain("provider");
    expect(repository).not.toContain("@aws-sdk");
  });

  it("runs no raw SQL", () => {
    for (const { path, code } of [
      ...sourceFiles(storageRoot),
      ...sourceFiles("tests/storage", true),
    ]) {
      expect(/\$(?:queryRawUnsafe|executeRawUnsafe)/.test(code), path).toBe(
        false,
      );
    }
  });
});

describe("the closed sets", () => {
  it("names the object and intent states, and the two inspection settings", () => {
    expect(STORAGE_OBJECT_STATUSES).toEqual([
      "pending",
      "ready",
      "quarantined",
      "rejected",
      "expired",
    ]);
    expect(UPLOAD_INTENT_STATUSES).toEqual([
      "pending",
      "finalizing",
      "finalized",
      "quarantined",
      "rejected",
      "expired",
    ]);
    expect(Object.values(UPLOAD_INSPECTION)).toEqual(["optional", "required"]);
    expect(STORAGE_INSPECTION_RESULTS).toEqual([
      "not-configured",
      "clean",
      "quarantined",
    ]);
  });

  it("names every log event under one prefix", () => {
    for (const event of Object.values(STORAGE_LOG_EVENT)) {
      expect(event.startsWith("storage.")).toBe(true);
    }
  });
});

describe("the platform holds no business vocabulary", () => {
  it("defines no upload policy of its own", () => {
    for (const { path, code } of storageFiles) {
      expect(code.includes("defineUploadPolicy({"), path).toBe(false);
    }
  });

  it("names no document, invoice, avatar, or receipt", () => {
    // `attachment` is deliberately not on this list: it is the HTTP
    // `Content-Disposition` token, not a business noun.
    for (const { path, code } of storageFiles) {
      for (const word of ["document", "invoice", "avatar", "receipt"]) {
        expect(code.toLowerCase().includes(word), `${path}: ${word}`).toBe(
          false,
        );
      }
    }
  });

  it("declares no permission and no audit action", () => {
    for (const { path, code } of storageFiles) {
      expect(code.includes("PERMISSION"), path).toBe(false);
      expect(code.includes("defineAuditAction"), path).toBe(false);
    }
  });

  it("receives no actor anywhere in its public surface", () => {
    // Who may upload and who may download are decisions the calling module
    // makes. A parameter here would be the platform quietly taking one.
    const entry = read(`${storageRoot}/index.server.ts`);

    expect(entry).not.toContain("Actor");
    expect(entry).not.toContain("userId");
    expect(entry).not.toContain("sessionId");
  });
});

describe("no route, no page, no worker", () => {
  it("adds no upload or download route", () => {
    for (const { path, code } of sourceFiles("src/app")) {
      expect(code.includes("@/platform/storage"), path).toBe(false);
    }
  });

  it("leaves the route handler factory without multipart parsing", () => {
    const routeInput = stripComments(read("src/platform/http/route-input.ts"));
    const defineRoute = stripComments(
      read("src/platform/http/define-route.server.ts"),
    );

    for (const source of [routeInput, defineRoute]) {
      expect(source).not.toContain("FormData");
      expect(source).not.toContain("multipart");
      expect(source).not.toContain("formData");
    }
  });

  it("schedules nothing", () => {
    for (const { path, code } of storageFiles) {
      // `setTimeout` inside the adapter is a request deadline, which is the
      // opposite of scheduling: it makes a call stop rather than start. A
      // repeating timer is what must not exist.
      expect(/setInterval|cron|Cron|schedule/.test(code), path).toBe(false);
    }
  });

  it("adds no worker entry point", () => {
    for (const { path, code } of sourceFiles("src/worker")) {
      expect(code.includes("@/platform/storage"), path).toBe(false);
    }
  });
});

describe("storage is optional", () => {
  it("reads its environment lazily and never at startup", () => {
    const serverEntry = read("src/config/env/index.server.ts");

    expect(serverEntry).not.toContain("readStorageEnvironment");
    expect(serverEntry).not.toContain("storageEnv");
  });

  it("declares its variables apart from the server schema", () => {
    const schema = read("src/config/env/schema.ts");
    const serverBlock =
      schema.match(/export const serverEnvironmentSchema[\s\S]*?\n\n/)?.[0] ??
      "";

    expect(serverBlock).not.toContain("STORAGE_");
    expect(schema).toContain("storageEnvironmentSchema");
  });

  it("has no default endpoint of any kind", () => {
    const schema = stripComments(read("src/config/env/schema.ts"));
    const storageBlock =
      schema.match(
        /export const storageEnvironmentSchema[\s\S]*?export type DatabaseEnvironment/,
      )?.[0] ?? "";

    expect(storageBlock).not.toContain("localhost");
    expect(storageBlock).not.toContain("127.0.0.1");
    expect(storageBlock).not.toContain("minio");
    expect(storageBlock).not.toContain("amazonaws");
  });

  it("exposes no storage variable to the browser", () => {
    const publicEntry = read("src/config/env/index.client.ts");

    expect(publicEntry).not.toContain("STORAGE");
  });

  it("builds no client at import time", () => {
    const client = stripComments(
      read(`${providerRoot}/storage-client.server.ts`),
    );

    // Everything is inside a function. A top-level `new S3Client` would resolve
    // an endpoint's hostname the moment anything imported this module.
    expect(client).not.toMatch(/^const \w+ = createS3StorageProvider/m);
    expect(client).toContain("current.provider ??=");
  });
});

describe("the migration", () => {
  it("adds exactly one migration for this change", () => {
    const matching = readdirSync(migrationsRoot).filter((entry) =>
      entry.endsWith(migrationName),
    );

    expect(matching).toHaveLength(1);
  });

  it("is additive", () => {
    expect(migrationSql).not.toMatch(/DROP TABLE/i);
    expect(migrationSql).not.toMatch(/DROP TYPE/i);
    expect(migrationSql).not.toMatch(/TRUNCATE/i);
    expect(migrationSql).not.toMatch(/DELETE FROM/i);
  });

  it("touches no table this change does not own", () => {
    for (const table of [
      "audit_record",
      "authorization_audit_record",
      "outbox_message",
      "job_execution_receipt",
      '"user"',
      "session",
      "account",
    ]) {
      expect(migrationSql.includes(`ALTER TABLE ${table}`), table).toBe(false);
    }
  });

  it("constrains the shape of a key, a checksum, and a token hash", () => {
    for (const constraint of [
      "storage_object_key_pattern",
      "storage_object_key_namespace",
      "storage_object_checksum_canonical",
      "storage_object_ready_state",
      "storage_object_quarantined_state",
      "storage_upload_intent_staging_key_pattern",
      "storage_upload_intent_finalize_token_hash_canonical",
      "storage_upload_intent_lease_pair",
      "storage_upload_intent_finalizing_state",
      "storage_upload_intent_finalized_state",
      "storage_upload_intent_expiry_after_creation",
      "storage_upload_intent_version_positive",
    ]) {
      expect(migrationSql, constraint).toContain(constraint);
    }
  });

  it("leaves every historical migration untouched", () => {
    const historical = readdirSync(migrationsRoot).filter(
      (entry) =>
        entry !== "migration_lock.toml" && entry !== migrationDirectory,
    );

    expect(historical.length).toBeGreaterThan(0);

    for (const entry of historical) {
      const sql = read(`prisma/migrations/${entry}/migration.sql`);

      expect(sql.includes("storage_object"), entry).toBe(false);
      expect(sql.includes("storage_upload_intent"), entry).toBe(false);
    }
  });

  it("declares the models in their own schema file", () => {
    expect(existsSync(resolve(projectRoot, "prisma/storage.prisma"))).toBe(
      true,
    );

    const schema = read("prisma/storage.prisma");

    expect(schema).toContain("model StorageObject");
    expect(schema).toContain("model StorageUploadIntent");
    // No foreign key to a person or a business record: who owns a file is the
    // calling module's question.
    expect(schema).not.toContain("references: [id])\n  user");
    expect(schema).not.toContain("User");
    expect(schema).not.toContain("Session");
  });
});

describe("the Compose stack is independent", () => {
  it("lives in its own file under its own project name", () => {
    expect(existsSync(resolve(projectRoot, "compose.storage.yaml"))).toBe(true);
    expect(
      existsSync(resolve(projectRoot, "compose.storage.env.example")),
    ).toBe(true);

    const compose = read("compose.storage.yaml");

    expect(compose).toContain("next-fullstack-starter-storage");
    expect(compose).toContain("minio-test");
  });

  it("pins the image to a release", () => {
    const compose = read("compose.storage.yaml");

    expect(compose).not.toMatch(/minio\/minio:latest/);
    expect(compose).toMatch(/minio\/minio:RELEASE\./);
  });

  it("binds every port to the loopback interface", () => {
    const compose = read("compose.storage.yaml");
    const ports = compose.match(/^\s+- "[^"]+:\d+"/gm) ?? [];

    expect(ports.length).toBeGreaterThan(0);

    for (const port of ports) {
      expect(port).toContain("127.0.0.1:");
    }
  });

  it("gives the test container no persistence and its own port", () => {
    const compose = read("compose.storage.yaml");
    const testService = compose.slice(compose.indexOf("minio-test:"));

    expect(testService).toContain("tmpfs:");
    expect(testService).toContain('restart: "no"');
    expect(testService).toContain("MINIO_TEST_PORT:-9100");
  });

  it("commits no credential", () => {
    const example = read("compose.storage.env.example");

    expect(example).toContain("replace_with_local_secret");
    expect(read(".gitignore")).toContain("compose.storage.env");
  });

  it("does not start or stop the other stacks", () => {
    const manifest = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };

    for (const [name, script] of Object.entries(manifest.scripts)) {
      if (name.startsWith("storage:")) {
        expect(script, name).toContain("compose.storage.yaml");
        expect(script, name).not.toContain("postgres");
        expect(script, name).not.toContain("redis");
      }

      if (name.startsWith("db:") || name.startsWith("redis:")) {
        expect(script, name).not.toContain("minio");
        expect(script, name).not.toContain("compose.storage");
      }
    }
  });
});

describe("the dedicated test suite", () => {
  it("is not reachable from the default configuration", () => {
    expect(existsSync(resolve(projectRoot, "vitest.storage.config.ts"))).toBe(
      true,
    );

    const defaultConfig = read("vitest.config.ts");

    expect(defaultConfig).not.toContain("tests/storage");
    expect(defaultConfig).not.toContain("storage.test");
  });

  it("is opted into by one script", () => {
    const manifest = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts["test:storage:integration"]).toBe(
      "vitest run --config vitest.storage.config.ts",
    );
    expect(manifest.scripts.verify).not.toContain("storage");
  });

  it("hides no failure behind a skip, a retry, or a raised timeout", () => {
    for (const { path, code } of sourceFiles("tests/storage", true)) {
      expect(
        /\b(?:it|test|describe)\.(?:skip|todo|only)\b/.test(code),
        path,
      ).toBe(false);
      expect(code.includes("retry:"), path).toBe(false);
      expect(code.includes("waitForTimeout"), path).toBe(false);
    }
  });
});

describe("CI keeps storage disabled by default", () => {
  const workflow = read(".github/workflows/ci.yml");

  /**
   * The job-level `env:` block, which is at four spaces of indentation. A
   * service's own `env:` is at eight, and matching that one instead would make
   * the assertions below look at the wrong block.
   */
  const jobEnvironment = workflow.slice(
    workflow.indexOf("\n    env:\n"),
    workflow.indexOf("\n    steps:\n"),
  );

  it("sets STORAGE_ENABLED to false for the whole job", () => {
    expect(jobEnvironment).toContain('STORAGE_ENABLED: "false"');
  });

  it("gives the job no endpoint, bucket, or credential", () => {
    for (const name of [
      "STORAGE_ENDPOINT",
      "STORAGE_BUCKET",
      "STORAGE_ACCESS_KEY_ID",
      "STORAGE_SECRET_ACCESS_KEY",
    ]) {
      expect(jobEnvironment, name).not.toContain(name);
    }
  });

  it("starts MinIO with the command it needs and waits for it", () => {
    // The image's default command prints its usage and exits, so `server /data`
    // is not decoration — without it the container would come up dead. That is
    // also why MinIO is a step rather than a `services:` entry: a service
    // container has no way to supply a command.
    expect(workflow).toContain("minio/minio:RELEASE.");
    expect(workflow).toContain("server /data");
    expect(workflow).not.toMatch(/minio\/minio:latest/);
    expect(workflow).toContain("--health-cmd");
    expect(workflow).toContain("State.Health.Status");
  });

  it("enables storage in exactly one step", () => {
    const enablingSteps = workflow
      .split("      - name: ")
      .filter((step) => step.includes('STORAGE_ENABLED: "true"'));

    expect(enablingSteps).toHaveLength(1);
    expect(enablingSteps[0]).toContain("Run storage integration tests");
    expect(enablingSteps[0]).toContain("pnpm test:storage:integration");
  });

  it("keeps the Redis and jobs steps as they were", () => {
    expect(workflow).toContain("pnpm test:redis:integration");
    expect(workflow).toContain("pnpm test:jobs:integration");
    expect(workflow).toContain('REDIS_ENABLED: "false"');
    expect(workflow).toContain('JOBS_ENABLED: "false"');
  });

  it("keeps the workflow and job names", () => {
    expect(workflow).toContain("name: CI");
    expect(workflow).toContain("name: Verify");
  });
});

describe("the architecture rules are declared", () => {
  it("keeps the AWS SDK inside the provider directory", () => {
    const rule = forbiddenRules.find(
      (entry) => entry.name === "no-storage-driver-outside-provider",
    );

    expect(rule?.severity).toBe("error");
    expect(rule?.to?.path).toContain("@aws-sdk/");
    expect(rule?.from?.pathNot).toContain("src/platform/storage/provider/");
  });

  it("refuses the MinIO SDK", () => {
    const rule = forbiddenRules.find((entry) => entry.name === "no-minio-sdk");

    expect(rule?.severity).toBe("error");
    expect(rule?.to?.path).toContain("minio");
  });

  it("keeps the platform's internals private", () => {
    const rule = forbiddenRules.find(
      (entry) => entry.name === "no-storage-platform-internal-imports",
    );

    expect(rule?.severity).toBe("error");
    expect(rule?.to?.path).toContain("index\\.server\\.ts");
  });

  it("refuses every area the platform must not reach", () => {
    const rule = forbiddenRules.find(
      (entry) => entry.name === "no-storage-to-application-areas",
    );

    expect(rule?.severity).toBe("error");

    for (const area of ["auth", "audit", "redis", "cache", "jobs", "worker"]) {
      expect(rule?.to?.path, area).toContain(area);
    }
  });

  it("declares an ESLint block for the platform and one for the adapter", () => {
    expect(eslintBlock("architecture/storage-platform")).toBeDefined();
    expect(eslintBlock("architecture/storage-provider")).toBeDefined();

    const platform = restrictedPatterns("architecture/storage-platform");
    const provider = restrictedPatterns("architecture/storage-provider");

    // The platform refuses the SDK; the adapter is the one place that may hold
    // it, and refuses persistence instead.
    expect(platform.some((regex) => regex.includes("aws-sdk"))).toBe(true);
    expect(provider.some((regex) => regex.includes("aws-sdk"))).toBe(false);
    expect(provider.some((regex) => regex.includes("platform/database"))).toBe(
      true,
    );

    for (const patterns of [platform, provider]) {
      expect(patterns.some((regex) => regex.includes("platform/auth"))).toBe(
        true,
      );
    }
  });

  it("uses no suppression comment anywhere in the area", () => {
    // Assembled at runtime so this file does not contain the markers it forbids.
    const markers = [
      ["eslint", "disable"].join("-"),
      ["@ts", "ignore"].join("-"),
      ["@ts", "expect", "error"].join("-"),
      ["depcruise", "ignore"].join("-"),
    ];

    for (const { path, source } of [
      ...sourceFiles(storageRoot, true),
      ...sourceFiles("tests/storage", true),
      { path: "prisma/storage.prisma", source: read("prisma/storage.prisma") },
    ]) {
      for (const marker of markers) {
        expect(source.includes(marker), `${path}: ${marker}`).toBe(false);
      }
    }
  });
});

describe("the documentation exists", () => {
  it("carries an architecture note and a platform README", () => {
    expect(
      existsSync(
        resolve(projectRoot, "docs/architecture/object-storage-and-uploads.md"),
      ),
    ).toBe(true);
    expect(existsSync(resolve(projectRoot, `${storageRoot}/README.md`))).toBe(
      true,
    );
  });

  it("states the limits rather than implying safety", () => {
    const note = read("docs/architecture/object-storage-and-uploads.md");

    for (const claim of [
      "capability, not a feature",
      "must be private",
      "no exactly-once transaction",
      "safe",
      "authoriz",
    ]) {
      expect(note.toLowerCase(), claim).toContain(claim.toLowerCase());
    }
  });
});
