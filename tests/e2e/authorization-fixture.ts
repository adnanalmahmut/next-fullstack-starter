import { loadEnvConfig } from "@next/env";
import { Client } from "pg";

/**
 * Test-only provisioning for the administration flows.
 *
 * Creating the first administrator is a deployment task, so the application
 * exposes no endpoint for it. These helpers therefore reach the database
 * directly, under three restrictions:
 *
 * - The target host must be local. A non-local host is refused outright, so a
 *   deployment URL can never be reached by accident.
 * - Every statement is filtered by this suite's own email shape, so no row that
 *   the suite did not create can be read or changed.
 * - Nothing here runs inside the application. It is a fixture for the Playwright
 *   process only.
 *
 * The shared Prisma client cannot be reused here: it is marked `server-only`, and
 * that marker throws outside a React Server Component. So the fixture speaks SQL
 * through the driver the adapter already depends on, with parameterized values.
 */
export const TEST_EMAIL_PREFIX = "authz-e2e-";
export const TEST_EMAIL_DOMAIN = "@example.test";
export const TEST_PASSWORD = "e2e-test-only-password";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

let connectionString: string | undefined;

function databaseUrl(): string {
  if (connectionString) {
    return connectionString;
  }

  loadEnvConfig(process.cwd());

  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error("DATABASE_URL is not configured for the test fixture.");
  }

  const host = new URL(url).hostname;

  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `The authorization fixture refuses a non-local database host: ${host}`,
    );
  }

  connectionString = url;

  return url;
}

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl() });

  await client.connect();

  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

function assertTestEmail(email: string) {
  if (
    !email.startsWith(TEST_EMAIL_PREFIX) ||
    !email.endsWith(TEST_EMAIL_DOMAIN)
  ) {
    throw new Error(`The authorization fixture refuses the address ${email}`);
  }
}

export function uniqueTestEmail(label: string): string {
  return `${TEST_EMAIL_PREFIX}${label}-${crypto.randomUUID()}${TEST_EMAIL_DOMAIN}`;
}

/** Assigns the admin role to an account this suite created. */
export async function grantAdminRole(email: string): Promise<string> {
  assertTestEmail(email);

  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      'UPDATE "user" SET role = $1 WHERE email = $2 RETURNING id',
      ["admin", email],
    );

    if (result.rowCount !== 1) {
      throw new Error(`Expected exactly one account for ${email}`);
    }

    return result.rows[0].id;
  });
}

export async function findTestUserId(email: string): Promise<string> {
  assertTestEmail(email);

  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      'SELECT id FROM "user" WHERE email = $1',
      [email],
    );

    if (result.rowCount !== 1) {
      throw new Error(`Expected exactly one account for ${email}`);
    }

    return result.rows[0].id;
  });
}

/**
 * Leaves the given account as the only administrator, so the
 * last-administrator refusal can be observed. Only this suite's accounts are
 * demoted; an administrator the suite did not create is reported instead.
 */
export async function makeSoleAdmin(email: string): Promise<number> {
  assertTestEmail(email);

  return withClient(async (client) => {
    await client.query(
      `UPDATE "user" SET role = 'user'
       WHERE email LIKE $1 AND email LIKE $2 AND email <> $3
         AND (role = 'admin' OR role LIKE 'admin,%' OR role LIKE '%,admin' OR role LIKE '%,admin,%')`,
      [`${TEST_EMAIL_PREFIX}%`, `%${TEST_EMAIL_DOMAIN}`, email],
    );

    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "user"
       WHERE email <> $1
         AND (role = 'admin' OR role LIKE 'admin,%' OR role LIKE '%,admin' OR role LIKE '%,admin,%')`,
      [email],
    );

    return Number(result.rows[0].count);
  });
}

export type AuditRow = {
  readonly action: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly actorSessionId: string | null;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly result: string;
  readonly requestId: string | null;
  readonly metadata: unknown;
};

/**
 * The records for one resource, read from the application audit trail.
 *
 * `audit_record` is the live table; `authorization_audit_record` is frozen and
 * receives no new rows, which `findLegacyAuditRowCount` is here to prove.
 */
export async function findAuditRows(resourceId: string): Promise<AuditRow[]> {
  return withClient(async (client) => {
    const result = await client.query<AuditRow>(
      `SELECT action, "actorType"::text AS "actorType", "actorId", "actorSessionId",
              "resourceType", "resourceId", "result"::text AS "result",
              "requestId", metadata
       FROM audit_record
       WHERE "resourceId" = $1
       ORDER BY "occurredAt" DESC, id DESC`,
      [resourceId],
    );

    return result.rows;
  });
}

export async function findLegacyAuditRowCount(): Promise<number> {
  return withClient(async (client) => {
    const result = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM authorization_audit_record",
    );

    return Number(result.rows[0].count);
  });
}

/**
 * Removes every account this suite created, and the audit rows that refer to
 * them. Child rows come before the parent, so the cleanup does not rely on
 * cascade, and the audit table has no foreign key at all.
 */
export async function removeTestAccounts(): Promise<void> {
  await withClient(async (client) => {
    const users = await client.query<{ id: string }>(
      'SELECT id FROM "user" WHERE email LIKE $1 AND email LIKE $2',
      [`${TEST_EMAIL_PREFIX}%`, `%${TEST_EMAIL_DOMAIN}`],
    );
    const ids = users.rows.map((row) => row.id);

    if (ids.length === 0) {
      return;
    }

    await client.query(
      'DELETE FROM audit_record WHERE "actorId" = ANY($1) OR "resourceId" = ANY($1)',
      [ids],
    );
    await client.query('DELETE FROM "session" WHERE "userId" = ANY($1)', [ids]);
    await client.query('DELETE FROM "account" WHERE "userId" = ANY($1)', [ids]);
    await client.query('DELETE FROM "user" WHERE id = ANY($1)', [ids]);
  });
}
