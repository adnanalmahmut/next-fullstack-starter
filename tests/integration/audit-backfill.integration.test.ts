import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { loadEnvConfig } from "@next/env";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

loadEnvConfig(process.cwd());

/**
 * Proof that the backfill actually copies the history, run against PostgreSQL.
 *
 * Reading the migration's SQL and agreeing that it looks right is not proof. The
 * only way to know that the copy preserves what it claims to preserve is to have
 * the legacy rows in a database, run the migration over them the way a deployment
 * would, and look at what came out. So that is what this does:
 *
 *  1. create a disposable schema on the local test server;
 *  2. apply the migration history up to the previous pull request;
 *  3. baseline that history in Prisma's own `_prisma_migrations` table;
 *  4. insert one row of each legacy action;
 *  5. run `prisma migrate deploy`, which applies exactly the new migration,
 *     through Prisma's normal history;
 *  6. assert what the new table holds, and that the old one still holds it too;
 *  7. drop the schema.
 *
 * A schema rather than a database: creating one needs no elevated privilege
 * beyond what the test role already has on its own database, and dropping it
 * takes the whole experiment with it. Nothing here touches the development
 * database, resets anything, or runs against a shared target — the suite refuses
 * to start unless `APP_ENV` is `test` and the host is local.
 */
const run = promisify(execFile);

const projectRoot = process.cwd();
const migrationsRoot = resolve(projectRoot, "prisma/migrations");

const NEW_MIGRATION_SUFFIX = "establish_application_audit_platform";

const migrationNames = readdirSync(migrationsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const newMigration = migrationNames.find((name) =>
  name.endsWith(NEW_MIGRATION_SUFFIX),
);
const historicalMigrations = migrationNames.filter(
  (name) => name !== newMigration,
);

const schemaName = `audit_backfill_${randomUUID().replaceAll("-", "")}`;

function baseUrl(): URL {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid");

  expect(process.env.APP_ENV).toBe("test");
  expect(["127.0.0.1", "localhost", "::1"]).toContain(url.hostname);

  return url;
}

function disposableUrl(): string {
  const url = baseUrl();

  url.searchParams.set("schema", schemaName);

  return url.toString();
}

async function withAdminClient<T>(
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: baseUrl().toString() });

  await client.connect();

  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function withSchemaClient<T>(
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: baseUrl().toString() });

  await client.connect();

  try {
    await client.query(`SET search_path TO "${schemaName}"`);

    return await work(client);
  } finally {
    await client.end();
  }
}

async function prisma(...args: readonly string[]): Promise<void> {
  await run("pnpm", ["exec", "prisma", ...args], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: disposableUrl() },
  });
}

const ROLE_SET_ID = "0198f0e0-1111-7222-8333-444455556661";
const REVOKED_ID = "0198f0e0-1111-7222-8333-444455556662";
const ROLE_SET_AT = new Date("2026-07-31T22:10:00.000Z");
const REVOKED_AT = new Date("2026-07-31T22:20:00.000Z");
const REQUEST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

type LegacyRow = Readonly<{
  id: string;
  occurredAt: Date;
  actorUserId: string;
  actorSessionId: string;
  action: string;
  targetUserId: string;
  requestId: string | null;
  metadata: unknown;
}>;

const legacyRows: readonly LegacyRow[] = [
  {
    id: ROLE_SET_ID,
    occurredAt: ROLE_SET_AT,
    actorUserId: "legacy-actor-1",
    actorSessionId: "legacy-session-1",
    action: "identity.user.role-set",
    targetUserId: "legacy-target-1",
    requestId: REQUEST_ID,
    metadata: { role: "admin" },
  },
  {
    id: REVOKED_ID,
    occurredAt: REVOKED_AT,
    actorUserId: "legacy-actor-2",
    actorSessionId: "legacy-session-2",
    action: "identity.session.revoked",
    targetUserId: "legacy-target-2",
    requestId: null,
    metadata: { scope: "all" },
  },
];

type CopiedRow = Readonly<{
  id: string;
  occurredAt: Date;
  actorType: string;
  actorId: string;
  actorSessionId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  result: string;
  requestId: string | null;
  metadata: unknown;
}>;

let copied: readonly CopiedRow[] = [];
let legacyAfter: readonly LegacyRow[] = [];

beforeAll(async () => {
  expect(newMigration).toBeDefined();
  expect(historicalMigrations.length).toBeGreaterThan(0);

  await withAdminClient(async (client) => {
    await client.query(`CREATE SCHEMA "${schemaName}"`);
  });

  // Steps 2 and 3: the history up to the previous pull request, applied as SQL
  // and then recorded as applied. `migrate resolve --applied` is Prisma's own
  // baselining command, so what follows sees a normal, consistent history.
  await withSchemaClient(async (client) => {
    for (const name of historicalMigrations) {
      const { readFileSync } = await import("node:fs");

      await client.query(
        readFileSync(resolve(migrationsRoot, name, "migration.sql"), "utf8"),
      );
    }
  });

  for (const name of historicalMigrations) {
    await prisma("migrate", "resolve", "--applied", name);
  }

  // Step 4: the legacy history this backfill exists for.
  await withSchemaClient(async (client) => {
    for (const row of legacyRows) {
      await client.query(
        `INSERT INTO "authorization_audit_record"
           ("id", "occurredAt", "actorUserId", "actorSessionId", "action",
            "targetUserId", "requestId", "metadata")
         VALUES ($1, $2, $3, $4, $5::"authorization_audit_action", $6, $7, $8)`,
        [
          row.id,
          row.occurredAt,
          row.actorUserId,
          row.actorSessionId,
          row.action,
          row.targetUserId,
          row.requestId,
          JSON.stringify(row.metadata),
        ],
      );
    }
  });

  // Step 5: exactly one migration is pending, and this applies it.
  await prisma("migrate", "deploy");

  copied = await withSchemaClient(
    async (client) =>
      (
        await client.query<CopiedRow>(
          `SELECT "id", "occurredAt", "actorType"::text AS "actorType", "actorId",
                "actorSessionId", "action", "resourceType", "resourceId",
                "result"::text AS "result", "requestId", "metadata"
           FROM "audit_record"
          ORDER BY "occurredAt" ASC`,
        )
      ).rows,
  );

  legacyAfter = await withSchemaClient(
    async (client) =>
      (
        await client.query<LegacyRow>(
          `SELECT "id", "occurredAt", "actorUserId", "actorSessionId",
                "action"::text AS "action", "targetUserId", "requestId", "metadata"
           FROM "authorization_audit_record"
          ORDER BY "occurredAt" ASC`,
        )
      ).rows,
  );
}, 300_000);

afterAll(async () => {
  await withAdminClient(async (client) => {
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  });
}, 60_000);

describe("the legacy backfill", () => {
  it("copies every legacy row exactly once", () => {
    expect(copied).toHaveLength(legacyRows.length);
    expect(new Set(copied.map((row) => row.id)).size).toBe(legacyRows.length);
  });

  it("preserves the identifiers, so a record keeps its identity", () => {
    expect(copied.map((row) => row.id)).toEqual([ROLE_SET_ID, REVOKED_ID]);
  });

  it("preserves the timestamps", () => {
    expect(copied.map((row) => row.occurredAt.toISOString())).toEqual([
      ROLE_SET_AT.toISOString(),
      REVOKED_AT.toISOString(),
    ]);
  });

  it("maps the actor, including the session kept for investigation", () => {
    expect(
      copied.map((row) => [row.actorType, row.actorId, row.actorSessionId]),
    ).toEqual([
      ["user", "legacy-actor-1", "legacy-session-1"],
      ["user", "legacy-actor-2", "legacy-session-2"],
    ]);
  });

  it("keeps both action names unchanged", () => {
    expect(copied.map((row) => row.action)).toEqual([
      "identity.user.role-set",
      "identity.session.revoked",
    ]);
  });

  it("maps the target to a user resource for both actions", () => {
    // Including the revocation: its target has always been a user, which is why
    // the resource type is not derived from the action name.
    expect(copied.map((row) => [row.resourceType, row.resourceId])).toEqual([
      ["identity.user", "legacy-target-1"],
      ["identity.user", "legacy-target-2"],
    ]);
  });

  it("preserves the request identifiers, including the absent one", () => {
    expect(copied.map((row) => row.requestId)).toEqual([REQUEST_ID, null]);
  });

  it("preserves the metadata", () => {
    expect(copied.map((row) => row.metadata)).toEqual([
      { role: "admin" },
      { scope: "all" },
    ]);
  });

  it("records both as succeeded", () => {
    // The legacy trail only ever held completed changes: a record was written
    // after the mutation had already succeeded.
    expect(copied.map((row) => row.result)).toEqual(["succeeded", "succeeded"]);
  });

  it("leaves the legacy rows in place", () => {
    expect(legacyAfter).toHaveLength(legacyRows.length);
    expect(legacyAfter.map((row) => row.id)).toEqual([ROLE_SET_ID, REVOKED_ID]);
    expect(legacyAfter.map((row) => row.action)).toEqual([
      "identity.user.role-set",
      "identity.session.revoked",
    ]);
    expect(legacyAfter.map((row) => row.metadata)).toEqual([
      { role: "admin" },
      { scope: "all" },
    ]);
  });

  it("applied the new migration once, through Prisma's own history", async () => {
    const applied = await withSchemaClient(
      async (client) =>
        (
          await client.query<{ migration_name: string; count: string }>(
            `SELECT "migration_name", count(*)::text AS count
             FROM "_prisma_migrations"
            WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
            GROUP BY "migration_name"`,
          )
        ).rows,
    );
    const record = applied.find((row) => row.migration_name === newMigration);

    expect(record).toBeDefined();
    expect(record?.count).toBe("1");
  });

  it("leaves no migration pending afterwards", async () => {
    // `migrate deploy` is idempotent, so running it twice must be a no-op rather
    // than a second backfill.
    await prisma("migrate", "deploy");

    expect(
      await withSchemaClient(async (client) =>
        Number(
          (
            await client.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM "audit_record"`,
            )
          ).rows[0].count,
        ),
      ),
    ).toBe(legacyRows.length);
  }, 120_000);
});
