import { loadEnvConfig } from "@next/env";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

loadEnvConfig(process.cwd());

vi.doMock("server-only", () => ({}));

const { auth } = await import("@/platform/auth/auth.server");
const { database } = await import("@/platform/database/index.server");
const { ADMIN_ROLE, USER_ROLE } =
  await import("@/platform/auth/authorization/role");
const { ERROR_CODE } = await import("@/shared/errors/error-code");
const { REQUEST_ID_HEADER } =
  await import("@/platform/observability/request-id.server");

const { GET: listUsers } = await import("@/app/api/v1/admin/users/route");
const { GET: readUser } =
  await import("@/app/api/v1/admin/users/[userId]/route");
const { PATCH: setRole } =
  await import("@/app/api/v1/admin/users/[userId]/role/route");
const { POST: revokeSessions } =
  await import("@/app/api/v1/admin/users/[userId]/sessions/revoke/route");
const { GET: listAudit } = await import("@/app/api/v1/admin/audit/route");

/**
 * The moved administration endpoints, exercised end to end below the network.
 *
 * The handlers are the real ones the router mounts, the sessions are real
 * Better Auth sessions, and the database is the real local test database. Only
 * the transport is left out, so what these tests prove is exactly what a client
 * would observe: the status, the envelope, the correlation header, and the rows
 * the operation did or did not leave behind.
 */
const TEST_PASSWORD = "integration-test-only-password";
const EMAIL_PREFIX = "adminapi-";
const EMAIL_DOMAIN = "@example.test";
const MISSING_USER_ID = "missing-user-00000000-0000-4000-8000-000000000000";
const REQUEST_ID = "7c2f9b1a-3d4e-4f5a-9b8c-1d2e3f4a5b6c";
const BASE_URL = "http://localhost";

const createdUserIds: string[] = [];

function assertTestDatabase() {
  expect(process.env.APP_ENV).toBe("test");

  const host = new URL(process.env.DATABASE_URL ?? "postgresql://invalid")
    .hostname;

  expect(["127.0.0.1", "localhost", "::1"]).toContain(host);
}

function uniqueEmail(label: string): string {
  return `${EMAIL_PREFIX}${label}-${crypto.randomUUID()}${EMAIL_DOMAIN}`;
}

async function removeUsers(userIds: readonly string[]) {
  if (userIds.length === 0) {
    return;
  }

  await database.auditRecord.deleteMany({
    where: {
      OR: [
        { actorId: { in: [...userIds] } },
        { resourceId: { in: [...userIds] } },
      ],
    },
  });
  await database.session.deleteMany({
    where: { userId: { in: [...userIds] } },
  });
  await database.account.deleteMany({
    where: { userId: { in: [...userIds] } },
  });
  await database.user.deleteMany({ where: { id: { in: [...userIds] } } });
}

async function removeLeftoverTestUsers() {
  const leftovers = await database.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: EMAIL_DOMAIN } },
    select: { id: true },
  });

  await removeUsers(leftovers.map((user) => user.id));
}

async function signUp(label: string): Promise<string> {
  const response = await auth.api.signUpEmail({
    body: {
      email: uniqueEmail(label),
      password: TEST_PASSWORD,
      name: `Admin API ${label}`,
    },
    asResponse: true,
  });

  expect(response.status, await response.clone().text()).toBe(200);

  const body = (await response.json()) as { user: { id: string } };

  createdUserIds.push(body.user.id);

  return body.user.id;
}

async function signIn(userId: string): Promise<string> {
  const user = await database.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true },
  });
  const response = await auth.api.signInEmail({
    body: { email: user.email, password: TEST_PASSWORD },
    asResponse: true,
  });

  expect(response.status).toBe(200);

  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function setStoredRole(userId: string, role: string | null) {
  await database.user.update({ where: { id: userId }, data: { role } });
}

async function createUser(label: string) {
  const userId = await signUp(label);

  return { userId, cookie: await signIn(userId) };
}

async function createAdmin(label: string) {
  const userId = await signUp(label);

  await setStoredRole(userId, ADMIN_ROLE);

  return { userId, cookie: await signIn(userId) };
}

/**
 * Leaves one administrator in place, so the last-administrator conflict can be
 * observed. Only accounts matching this suite's own email shape are touched.
 */
async function demoteOtherTestAdmins(exceptUserId: string) {
  await database.user.updateMany({
    where: {
      id: { not: exceptUserId },
      email: { startsWith: EMAIL_PREFIX, endsWith: EMAIL_DOMAIN },
      OR: [
        { role: ADMIN_ROLE },
        { role: { startsWith: `${ADMIN_ROLE},` } },
        { role: { endsWith: `,${ADMIN_ROLE}` } },
        { role: { contains: `,${ADMIN_ROLE},` } },
      ],
    },
    data: { role: USER_ROLE },
  });
}

type CallOptions = {
  cookie?: string;
  method?: string;
  body?: string;
  requestId?: string | null;
};

function buildRequest(
  path: string,
  { cookie, method = "GET", body, requestId = REQUEST_ID }: CallOptions,
): NextRequest {
  return new NextRequest(`${BASE_URL}${path}`, {
    method,
    ...(body === undefined ? {} : { body }),
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(requestId === null ? {} : { [REQUEST_ID_HEADER]: requestId }),
    },
  });
}

type Answer = {
  status: number;
  requestId: string | null;
  body: unknown;
  text: string;
};

async function answer(response: Response): Promise<Answer> {
  const text = await response.text();

  return {
    status: response.status,
    requestId: response.headers.get(REQUEST_ID_HEADER),
    body: JSON.parse(text) as unknown,
    text,
  };
}

type Handler = (
  request: NextRequest,
  context: { params: Promise<unknown> },
) => Promise<Response>;

function call(
  handler: Handler,
  path: string,
  options: CallOptions = {},
  params: unknown = {},
): Promise<Answer> {
  return handler(buildRequest(path, options), {
    params: Promise.resolve(params),
  }).then(answer);
}

function usersPath(query = ""): string {
  return `/api/v1/admin/users${query}`;
}

function userPath(userId: string): string {
  return `/api/v1/admin/users/${userId}`;
}

async function auditFor(resourceId: string) {
  return database.auditRecord.findMany({
    where: { resourceId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
}

async function sessionCountFor(userId: string): Promise<number> {
  return database.session.count({ where: { userId } });
}

beforeAll(async () => {
  assertTestDatabase();
  await removeLeftoverTestUsers();
});

afterAll(async () => {
  await removeUsers(createdUserIds);
  await database.$disconnect();
});

describe("unauthenticated callers", () => {
  it.each([
    { name: "the user list", run: () => call(listUsers, usersPath()) },
    {
      name: "a user read",
      run: () => call(readUser, userPath("user-1"), {}, { userId: "user-1" }),
    },
    {
      name: "a role change",
      run: () =>
        call(
          setRole,
          `${userPath("user-1")}/role`,
          { method: "PATCH", body: JSON.stringify({ role: USER_ROLE }) },
          { userId: "user-1" },
        ),
    },
    {
      name: "a session revocation",
      run: () =>
        call(
          revokeSessions,
          `${userPath("user-1")}/sessions/revoke`,
          { method: "POST" },
          { userId: "user-1" },
        ),
    },
    {
      name: "the audit trail",
      run: () => call(listAudit, "/api/v1/admin/audit"),
    },
  ])("refuses $name with 401", async ({ run }) => {
    const result = await run();

    expect(result.status).toBe(401);
    expect(result.body).toEqual({
      error: { code: ERROR_CODE.UNAUTHENTICATED },
    });
  });
});

describe("authenticated callers without the capability", () => {
  it.each([
    {
      name: "the user list",
      run: (cookie: string) => call(listUsers, usersPath(), { cookie }),
    },
    {
      name: "the audit trail",
      run: (cookie: string) =>
        call(listAudit, "/api/v1/admin/audit", { cookie }),
    },
  ])("refuses $name with 403", async ({ run }) => {
    const { cookie } = await createUser("denied");
    const result = await run(cookie);

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: { code: ERROR_CODE.FORBIDDEN } });
  });
});

describe("object-level protection", () => {
  it("answers identically for an existing and a missing target", async () => {
    const { cookie } = await createUser("bola");
    const target = await createUser("bola-target");

    const existing = await call(
      readUser,
      userPath(target.userId),
      { cookie },
      { userId: target.userId },
    );
    const missing = await call(
      readUser,
      userPath(MISSING_USER_ID),
      { cookie },
      { userId: MISSING_USER_ID },
    );

    expect(existing.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(existing.text).toBe(missing.text);
  });

  it("refuses an unparseable identifier the same way for every caller", async () => {
    // Input shape is validated before the session is read, so a malformed path
    // segment is a `400` for everyone. That reveals nothing about a record: it
    // is a statement about the caller's own input, not about the database.
    const denied = await createUser("bola-invalid");
    const admin = await createAdmin("bola-invalid-admin");

    const asUser = await call(
      readUser,
      userPath(""),
      {
        cookie: denied.cookie,
      },
      { userId: "" },
    );
    const asAdmin = await call(
      readUser,
      userPath(""),
      {
        cookie: admin.cookie,
      },
      { userId: "" },
    );
    const asVisitor = await call(readUser, userPath(""), {}, { userId: "" });

    for (const result of [asUser, asAdmin, asVisitor]) {
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: { code: ERROR_CODE.VALIDATION_FAILED },
      });
    }
  });
});

describe("administrative reads", () => {
  it("lists users in the success envelope", async () => {
    const { cookie } = await createAdmin("reader");

    const result = await call(listUsers, usersPath("?limit=5"), { cookie });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      data: { limit: 5, offset: 0 },
    });

    const { data } = result.body as {
      data: { users: { email: string }[]; total: number };
    };

    expect(Array.isArray(data.users)).toBe(true);
    expect(data.users.length).toBeLessThanOrEqual(5);
    expect(typeof data.total).toBe("number");
  });

  it("reads one user without a credential or session field", async () => {
    const { cookie } = await createAdmin("read-one");
    const target = await createUser("read-target");

    const result = await call(
      readUser,
      userPath(target.userId),
      { cookie },
      { userId: target.userId },
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ data: { id: target.userId } });

    for (const forbidden of [
      "password",
      "hash",
      "token",
      "session",
      "ipAddress",
      "userAgent",
      "banned",
    ]) {
      expect(result.text, forbidden).not.toContain(forbidden);
    }
  });

  it("answers 404 for a missing target once the caller is authorized", async () => {
    const { cookie } = await createAdmin("missing");

    const result = await call(
      readUser,
      userPath(MISSING_USER_ID),
      { cookie },
      { userId: MISSING_USER_ID },
    );

    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: { code: ERROR_CODE.NOT_FOUND } });
  });

  it("reads the audit trail bounded by its own capability", async () => {
    const { cookie } = await createAdmin("audit-reader");

    const result = await call(listAudit, "/api/v1/admin/audit?limit=3", {
      cookie,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ data: { limit: 3 } });
  });

  it("pages the audit trail by cursor and offers no offset", async () => {
    const admin = await createAdmin("audit-pager");
    const first = await createUser("audit-pager-first");
    const second = await createUser("audit-pager-second");

    for (const target of [first, second]) {
      await call(
        revokeSessions,
        `${userPath(target.userId)}/sessions/revoke`,
        { cookie: admin.cookie, method: "POST" },
        { userId: target.userId },
      );
    }

    const firstPage = await call(listAudit, "/api/v1/admin/audit?limit=1", {
      cookie: admin.cookie,
    });
    const firstBody = firstPage.body as {
      data: {
        records: Array<{ id: string }>;
        limit: number;
        nextCursor: string | null;
      };
    };

    expect(firstPage.status).toBe(200);
    expect(firstBody.data.records).toHaveLength(1);
    expect(firstBody.data.nextCursor).not.toBeNull();

    const secondPage = await call(
      listAudit,
      `/api/v1/admin/audit?limit=1&cursor=${encodeURIComponent(
        firstBody.data.nextCursor as string,
      )}`,
      { cookie: admin.cookie },
    );
    const secondBody = secondPage.body as {
      data: { records: Array<{ id: string }> };
    };

    expect(secondPage.status).toBe(200);
    expect(secondBody.data.records[0]?.id).not.toBe(
      firstBody.data.records[0]?.id,
    );

    // An offset is not part of the contract, and an undeclared parameter is
    // refused rather than ignored.
    expect(
      (
        await call(listAudit, "/api/v1/admin/audit?offset=1", {
          cookie: admin.cookie,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(listAudit, "/api/v1/admin/audit?cursor=not-a-cursor", {
          cookie: admin.cookie,
        })
      ).status,
    ).toBe(400);
  });

  it("returns a generic record and no acting session identifier", async () => {
    const admin = await createAdmin("audit-shape");
    const target = await createUser("audit-shape-target");

    await call(
      revokeSessions,
      `${userPath(target.userId)}/sessions/revoke`,
      { cookie: admin.cookie, method: "POST" },
      { userId: target.userId },
    );

    const result = await call(listAudit, "/api/v1/admin/audit?limit=50", {
      cookie: admin.cookie,
    });
    const body = result.body as {
      data: {
        records: Array<{
          resource: { id: string; type: string };
          actor: { id: string; type: string };
          action: string;
          result: string;
        }>;
      };
    };
    const record = body.data.records.find(
      (entry) => entry.resource.id === target.userId,
    );

    expect(record).toMatchObject({
      action: "identity.session.revoked",
      actor: { type: "user", id: admin.userId },
      resource: { type: "identity.user", id: target.userId },
      result: "succeeded",
    });
    expect(JSON.stringify(result.body)).not.toContain("actorSessionId");
  });
});

describe("invalid input", () => {
  it.each([
    {
      name: "an out-of-range query bound",
      run: (cookie: string) =>
        call(listUsers, usersPath("?limit=9999"), { cookie }),
    },
    {
      name: "an unknown query parameter",
      run: (cookie: string) =>
        call(listUsers, usersPath("?filterField=role"), { cookie }),
    },
    {
      name: "a repeated query parameter",
      run: (cookie: string) =>
        call(listUsers, usersPath("?limit=1&limit=50"), { cookie }),
    },
  ])("refuses $name with 400", async ({ run }) => {
    const { cookie } = await createAdmin("invalid-query");
    const result = await run(cookie);

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: { code: ERROR_CODE.VALIDATION_FAILED },
    });
  });

  it.each([
    { name: "malformed JSON", body: "{not json" },
    { name: "a missing role", body: JSON.stringify({}) },
    { name: "a non-string role", body: JSON.stringify({ role: 7 }) },
    {
      name: "a target named in the body",
      body: JSON.stringify({ role: USER_ROLE, userId: "someone-else" }),
    },
  ])("refuses a role change with $name", async ({ body }) => {
    const admin = await createAdmin("invalid-body");
    const target = await createUser("invalid-body-target");

    const result = await call(
      setRole,
      `${userPath(target.userId)}/role`,
      { cookie: admin.cookie, method: "PATCH", body },
      { userId: target.userId },
    );

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: { code: ERROR_CODE.VALIDATION_FAILED },
    });
    expect(await auditFor(target.userId)).toEqual([]);
  });

  it("refuses an unapproved role value", async () => {
    const admin = await createAdmin("bad-role");
    const target = await createUser("bad-role-target");

    const result = await call(
      setRole,
      `${userPath(target.userId)}/role`,
      {
        cookie: admin.cookie,
        method: "PATCH",
        body: JSON.stringify({ role: "superadmin" }),
      },
      { userId: target.userId },
    );

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: { code: ERROR_CODE.VALIDATION_FAILED },
    });
    expect(await auditFor(target.userId)).toEqual([]);
  });

  it("discloses no field name or supplied value in a refusal", async () => {
    const admin = await createAdmin("opaque");
    const target = await createUser("opaque-target");

    const result = await call(
      setRole,
      `${userPath(target.userId)}/role`,
      {
        cookie: admin.cookie,
        method: "PATCH",
        body: JSON.stringify({ role: "not-a-role-9f2c" }),
      },
      { userId: target.userId },
    );

    expect(result.text).toBe(
      JSON.stringify({ error: { code: ERROR_CODE.VALIDATION_FAILED } }),
    );
    expect(result.text).not.toContain("not-a-role-9f2c");
    expect(result.text).not.toContain("role");
    expect(result.text).not.toContain("issues");
  });
});

describe("role changes", () => {
  it("changes a role, records one audit entry, and persists it", async () => {
    const admin = await createAdmin("promoter");
    const target = await createUser("promoted");

    const result = await call(
      setRole,
      `${userPath(target.userId)}/role`,
      {
        cookie: admin.cookie,
        method: "PATCH",
        body: JSON.stringify({ role: ADMIN_ROLE }),
      },
      { userId: target.userId },
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      data: { id: target.userId, roles: [ADMIN_ROLE] },
    });

    const stored = await database.user.findUniqueOrThrow({
      where: { id: target.userId },
      select: { role: true },
    });

    expect(stored.role).toBe(ADMIN_ROLE);

    const records = await auditFor(target.userId);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      actorId: admin.userId,
      action: "identity.user.role-set",
      resourceType: "identity.user",
      resourceId: target.userId,
      result: "SUCCEEDED",
      requestId: REQUEST_ID,
    });
  });

  it("answers 409 for a refused self-demotion and records nothing", async () => {
    const admin = await createAdmin("last-admin");

    await demoteOtherTestAdmins(admin.userId);

    const result = await call(
      setRole,
      `${userPath(admin.userId)}/role`,
      {
        cookie: admin.cookie,
        method: "PATCH",
        body: JSON.stringify({ role: USER_ROLE }),
      },
      { userId: admin.userId },
    );

    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: { code: ERROR_CODE.CONFLICT } });
    expect(await auditFor(admin.userId)).toEqual([]);
  });
});

describe("session revocation", () => {
  it("revokes every session of the target and answers a null envelope", async () => {
    const admin = await createAdmin("revoker");
    const target = await createUser("revoked");

    await signIn(target.userId);

    expect(await sessionCountFor(target.userId)).toBeGreaterThan(1);

    const result = await call(
      revokeSessions,
      `${userPath(target.userId)}/sessions/revoke`,
      { cookie: admin.cookie, method: "POST" },
      { userId: target.userId },
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ data: null });
    expect(await sessionCountFor(target.userId)).toBe(0);
  });

  it("leaves the acting administrator signed in", async () => {
    const admin = await createAdmin("revoker-self");
    const target = await createUser("revoked-other");

    await call(
      revokeSessions,
      `${userPath(target.userId)}/sessions/revoke`,
      { cookie: admin.cookie, method: "POST" },
      { userId: target.userId },
    );

    const stillAuthorized = await call(listUsers, usersPath(), {
      cookie: admin.cookie,
    });

    expect(stillAuthorized.status).toBe(200);
  });

  it("refuses revoking the caller's own sessions with 403", async () => {
    const admin = await createAdmin("self-revoke");

    const result = await call(
      revokeSessions,
      `${userPath(admin.userId)}/sessions/revoke`,
      { cookie: admin.cookie, method: "POST" },
      { userId: admin.userId },
    );

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: { code: ERROR_CODE.FORBIDDEN } });
    expect(await sessionCountFor(admin.userId)).toBeGreaterThan(0);
  });

  it("records exactly one audit entry for a completed revocation", async () => {
    const admin = await createAdmin("revoke-audit");
    const target = await createUser("revoke-audited");

    await call(
      revokeSessions,
      `${userPath(target.userId)}/sessions/revoke`,
      { cookie: admin.cookie, method: "POST" },
      { userId: target.userId },
    );

    const records = await auditFor(target.userId);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      actorId: admin.userId,
      action: "identity.session.revoked",
      resourceType: "identity.user",
      resourceId: target.userId,
      result: "SUCCEEDED",
    });
  });

  it("does not audit a read", async () => {
    const admin = await createAdmin("read-audit");
    const target = await createUser("read-audited");

    await call(
      readUser,
      userPath(target.userId),
      { cookie: admin.cookie },
      { userId: target.userId },
    );

    expect(await auditFor(target.userId)).toEqual([]);
  });
});

describe("unexpected failures", () => {
  it("answers a sanitized 500 without a provider or database detail", async () => {
    const { cookie } = await createAdmin("internal");
    const listSpy = vi
      .spyOn(auth.api, "listUsers")
      .mockRejectedValue(
        new TypeError(
          'relation "user" does not exist at postgres://app:hunter2@db:5432',
        ),
      );

    try {
      const result = await call(listUsers, usersPath(), { cookie });

      expect(result.status).toBe(500);
      expect(result.text).toBe(
        JSON.stringify({ error: { code: ERROR_CODE.INTERNAL_ERROR } }),
      );
      expect(result.text).not.toContain("relation");
      expect(result.text).not.toContain("postgres://");
      expect(result.text).not.toContain("hunter2");
      expect(result.text).not.toContain("stack");
    } finally {
      listSpy.mockRestore();
    }
  });
});

describe("request correlation", () => {
  it("returns the propagated request id on success and on refusal", async () => {
    const { cookie } = await createAdmin("correlated");

    const success = await call(listUsers, usersPath(), { cookie });
    const refusal = await call(listUsers, usersPath());

    expect(success.status).toBe(200);
    expect(success.requestId).toBe(REQUEST_ID);
    expect(refusal.status).toBe(401);
    expect(refusal.requestId).toBe(REQUEST_ID);
  });

  it("creates a request id when the caller propagates none", async () => {
    const { cookie } = await createAdmin("uncorrelated");

    const result = await call(listUsers, usersPath(), {
      cookie,
      requestId: null,
    });

    expect(result.status).toBe(200);
    expect(result.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("replaces a request id the caller made up", async () => {
    const { cookie } = await createAdmin("bad-correlation");

    const result = await call(listUsers, usersPath(), {
      cookie,
      requestId: "../../etc/passwd",
    });

    expect(result.status).toBe(200);
    expect(result.requestId).not.toBe("../../etc/passwd");
  });
});
