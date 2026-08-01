import { loadEnvConfig } from "@next/env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

loadEnvConfig(process.cwd());

vi.doMock("server-only", () => ({}));

const { auth } = await import("@/platform/auth/auth.server");
const { database } = await import("@/platform/database/index.server");
const { getActorFromHeaders, requireActor } =
  await import("@/platform/auth/authorization/actor.server");
const {
  AUTHORIZATION_OUTCOME,
  requireAllPermissions,
  requireAnyPermission,
  requirePermission,
  resolveAuthorization,
} = await import("@/platform/auth/authorization/require-permission.server");
const { PERMISSION, PERMISSIONS } =
  await import("@/platform/auth/authorization/permission-registry");
const {
  getAdminUser,
  listAdminUsers,
  revokeAdminUserSessions,
  setAdminUserRole,
} = await import("@/platform/auth/authorization/admin-users.service.server");
const { listAuthorizationAudit } =
  await import("@/platform/auth/authorization/admin-audit.service.server");
const { countOtherAdmins } =
  await import("@/platform/auth/authorization/identity-read.repository.server");
const { AUDIT_ACTION } =
  await import("@/platform/auth/authorization/audit/audit-action");
const { ADMIN_ROLE, USER_ROLE } =
  await import("@/platform/auth/authorization/role");
const {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} = await import("@/shared/errors/application-error");

const TEST_PASSWORD = "integration-test-only-password";
const EMAIL_PREFIX = "authz-";
const EMAIL_DOMAIN = "@example.test";
const MISSING_USER_ID = "missing-user-00000000-0000-4000-8000-000000000000";
const REQUEST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

const createdUserIds: string[] = [];

/**
 * Cleanup is bounded to the rows these tests created, and it only runs after the
 * suite proves it is pointed at a local test target. `APP_ENV` is the project's
 * own signal for a test run, and a non-local host is refused outright so a
 * deployment URL can never be reached by accident.
 */
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

  // The audit trail has no foreign key, so its rows are removed explicitly.
  // Child rows come before the parent, so the cleanup does not rely on cascade.
  await database.authorizationAuditRecord.deleteMany({
    where: {
      OR: [
        { actorUserId: { in: [...userIds] } },
        { targetUserId: { in: [...userIds] } },
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

/**
 * Removes accounts a previous interrupted run may have left behind. The filter is
 * this suite's own email shape, so no other row can be touched.
 */
async function removeLeftoverTestUsers() {
  const leftovers = await database.user.findMany({
    where: {
      email: { startsWith: EMAIL_PREFIX, endsWith: EMAIL_DOMAIN },
    },
    select: { id: true },
  });

  await removeUsers(leftovers.map((user) => user.id));
}

async function signUp(label: string): Promise<string> {
  const email = uniqueEmail(label);
  const response = await auth.api.signUpEmail({
    body: { email, password: TEST_PASSWORD, name: `Authz ${label}` },
    asResponse: true,
  });

  expect(response.status, await response.clone().text()).toBe(200);

  const body = (await response.json()) as { user: { id: string } };

  createdUserIds.push(body.user.id);

  return body.user.id;
}

async function signIn(userId: string): Promise<Headers> {
  const user = await database.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true },
  });
  const response = await auth.api.signInEmail({
    body: { email: user.email, password: TEST_PASSWORD },
    asResponse: true,
  });

  expect(response.status).toBe(200);

  return new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; "),
  });
}

/**
 * Assigns a stored role directly. Creating the first administrator is a
 * deployment concern, so tests use the database they already proved is local.
 */
async function setStoredRole(userId: string, role: string | null) {
  await database.user.update({ where: { id: userId }, data: { role } });
}

async function createUser(label: string) {
  const userId = await signUp(label);

  return { userId, headers: await signIn(userId) };
}

async function createAdmin(label: string) {
  const userId = await signUp(label);

  await setStoredRole(userId, ADMIN_ROLE);

  return { userId, headers: await signIn(userId) };
}

async function actorFor(headers: Headers) {
  return requireActor(await getActorFromHeaders(headers));
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
      // The same whole-entry match the administrator count uses, so a stored
      // multi-role column is demoted too.
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

async function auditFor(targetUserId: string) {
  return database.authorizationAuditRecord.findMany({
    where: { targetUserId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
}

beforeAll(async () => {
  assertTestDatabase();
  await removeLeftoverTestUsers();
});

afterAll(async () => {
  await removeUsers(createdUserIds);
  await database.$disconnect();
});

describe("actor from a verified session", () => {
  it("builds a normalized actor", async () => {
    const { userId, headers } = await createUser("actor");
    const actor = await getActorFromHeaders(headers);

    expect(actor?.userId).toBe(userId);
    expect(actor?.sessionId).toBeTruthy();
    expect(actor?.roles).toEqual([USER_ROLE]);
    expect(Object.keys(actor ?? {}).sort()).toEqual([
      "email",
      "name",
      "roles",
      "sessionId",
      "userId",
    ]);
  });

  it("carries no session token", async () => {
    const { headers } = await createUser("actor-token");
    const actor = await getActorFromHeaders(headers);
    const cookie = headers.get("cookie") ?? "";

    expect(JSON.stringify(actor)).not.toContain(cookie.split("=")[1] ?? "?");
  });

  it("resolves nothing without a session", async () => {
    expect(await getActorFromHeaders(new Headers())).toBeNull();
    expect(() => requireActor(null)).toThrow(UnauthenticatedError);
  });

  it("resolves nothing for a revoked session", async () => {
    const { userId, headers } = await createUser("actor-revoked");

    await database.session.deleteMany({ where: { userId } });

    expect(await getActorFromHeaders(headers)).toBeNull();
  });

  it("resolves nothing for an expired session", async () => {
    const { userId, headers } = await createUser("actor-expired");

    await database.session.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    expect(await getActorFromHeaders(headers)).toBeNull();
  });

  it("reads the stored multi-role representation", async () => {
    const { userId, headers } = await createUser("actor-multi");

    await setStoredRole(userId, `${ADMIN_ROLE},${USER_ROLE}`);

    expect((await getActorFromHeaders(headers))?.roles).toEqual([
      ADMIN_ROLE,
      USER_ROLE,
    ]);
  });
});

describe("capability enforcement", () => {
  it("grants a default user no application capability", async () => {
    const { headers } = await createUser("capability-user");
    const actor = await actorFor(headers);

    for (const permission of PERMISSIONS) {
      await expect(
        requirePermission(actor, permission),
        permission,
      ).rejects.toThrow(ForbiddenError);
    }
  });

  it("grants an administrator every application capability", async () => {
    const { headers } = await createAdmin("capability-admin");
    const actor = await actorFor(headers);

    for (const permission of PERMISSIONS) {
      await expect(
        requirePermission(actor, permission),
        permission,
      ).resolves.toEqual(actor);
    }
  });

  it("grants through a multi-role column", async () => {
    const { userId, headers } = await createUser("capability-multi");

    await setStoredRole(userId, `${USER_ROLE},${ADMIN_ROLE}`);

    await expect(
      requirePermission(
        await actorFor(headers),
        PERMISSION.IDENTITY_ADMIN_ACCESS,
      ),
    ).resolves.toBeTruthy();
  });

  it("fails closed for an unrecognized role", async () => {
    const { userId, headers } = await createUser("capability-unknown");

    await setStoredRole(userId, "superadmin");

    await expect(
      requirePermission(
        await actorFor(headers),
        PERMISSION.IDENTITY_ADMIN_ACCESS,
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("fails closed for a blank role column", async () => {
    const { userId, headers } = await createUser("capability-blank");

    await setStoredRole(userId, null);

    await expect(
      requirePermission(
        await actorFor(headers),
        PERMISSION.IDENTITY_ADMIN_ACCESS,
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("reads the role from the database rather than the session snapshot", async () => {
    const { userId, headers } = await createUser("capability-demoted");

    await setStoredRole(userId, ADMIN_ROLE);

    const actor = await actorFor(headers);

    await expect(
      requirePermission(actor, PERMISSION.IDENTITY_ADMIN_ACCESS),
    ).resolves.toBeTruthy();

    await setStoredRole(userId, USER_ROLE);

    // The same actor object is now refused, because the capability is evaluated
    // against the stored role on every call.
    await expect(
      requirePermission(actor, PERMISSION.IDENTITY_ADMIN_ACCESS),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses an unauthenticated caller before any capability", async () => {
    await expect(
      requirePermission(null, PERMISSION.IDENTITY_ADMIN_ACCESS),
    ).rejects.toThrow(UnauthenticatedError);
    await expect(
      requireAnyPermission(undefined, [PERMISSION.IDENTITY_ADMIN_ACCESS]),
    ).rejects.toThrow(UnauthenticatedError);
    await expect(
      requireAllPermissions(null, [PERMISSION.IDENTITY_ADMIN_ACCESS]),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it("applies any semantics", async () => {
    const { headers } = await createUser("capability-any-user");
    const userActor = await actorFor(headers);
    const admin = await createAdmin("capability-any-admin");
    const adminActor = await actorFor(admin.headers);

    await expect(
      requireAnyPermission(adminActor, [
        PERMISSION.IDENTITY_AUDIT_READ,
        PERMISSION.IDENTITY_USER_LIST,
      ]),
    ).resolves.toEqual(adminActor);
    await expect(
      requireAnyPermission(userActor, [
        PERMISSION.IDENTITY_AUDIT_READ,
        PERMISSION.IDENTITY_USER_LIST,
      ]),
    ).rejects.toThrow(ForbiddenError);
  });

  it("applies all semantics", async () => {
    const { headers } = await createAdmin("capability-all");
    const actor = await actorFor(headers);

    await expect(
      requireAllPermissions(actor, [
        PERMISSION.IDENTITY_USER_LIST,
        PERMISSION.IDENTITY_AUDIT_READ,
      ]),
    ).resolves.toEqual(actor);
    await expect(
      requireAllPermissions(actor, [
        PERMISSION.IDENTITY_USER_LIST,
        PERMISSION.IDENTITY_USER_LIST,
      ]),
    ).resolves.toEqual(actor);
  });

  it("fails closed for an undeclared permission", async () => {
    const { headers } = await createAdmin("capability-undeclared");
    const actor = await actorFor(headers);

    await expect(
      requirePermission(actor, "identity.user.delete" as never),
    ).rejects.toThrow(ForbiddenError);
    await expect(requireAllPermissions(actor, [] as never)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("reports an outcome without throwing for a rendered state", async () => {
    const admin = await createAdmin("outcome-admin");
    const user = await createUser("outcome-user");

    expect(
      await resolveAuthorization(await actorFor(admin.headers), [
        PERMISSION.IDENTITY_ADMIN_ACCESS,
      ]),
    ).toBe(AUTHORIZATION_OUTCOME.GRANTED);
    expect(
      await resolveAuthorization(await actorFor(user.headers), [
        PERMISSION.IDENTITY_ADMIN_ACCESS,
      ]),
    ).toBe(AUTHORIZATION_OUTCOME.FORBIDDEN);
    expect(
      await resolveAuthorization(null, [PERMISSION.IDENTITY_ADMIN_ACCESS]),
    ).toBe(AUTHORIZATION_OUTCOME.UNAUTHENTICATED);
  });
});

describe("administrative reads", () => {
  it("lists users for an administrator", async () => {
    const admin = await createAdmin("read-list");
    const actor = await actorFor(admin.headers);
    const page = await listAdminUsers(
      { actor, headers: admin.headers },
      { limit: 20, offset: 0, sortBy: "createdAt", sortDirection: "desc" },
    );

    expect(page.total).toBeGreaterThan(0);
    expect(page.limit).toBe(20);
    expect(page.users.length).toBeGreaterThan(0);

    for (const user of page.users) {
      expect(Object.keys(user).sort()).toEqual([
        "createdAt",
        "email",
        "emailVerified",
        "id",
        "name",
        "roles",
      ]);
    }
  });

  it("reads an existing user", async () => {
    const admin = await createAdmin("read-get");
    const target = await createUser("read-target");
    const actor = await actorFor(admin.headers);

    expect(
      await getAdminUser({ actor, headers: admin.headers }, target.userId),
    ).toMatchObject({ id: target.userId, roles: [USER_ROLE] });
  });

  it("answers not found for a missing user", async () => {
    const admin = await createAdmin("read-missing");
    const actor = await actorFor(admin.headers);

    await expect(
      getAdminUser({ actor, headers: admin.headers }, MISSING_USER_ID),
    ).rejects.toThrow(NotFoundError);
  });

  it("exposes no credential or session field", async () => {
    const admin = await createAdmin("read-fields");
    const target = await createUser("read-fields-target");
    const actor = await actorFor(admin.headers);
    const serialized = JSON.stringify(
      await getAdminUser({ actor, headers: admin.headers }, target.userId),
    );

    for (const field of [
      "password",
      "token",
      "ipAddress",
      "userAgent",
      "banned",
      "banReason",
      TEST_PASSWORD,
    ]) {
      expect(serialized.includes(field), field).toBe(false);
    }
  });
});

describe("role changes", () => {
  it("changes another user's role and persists it", async () => {
    const admin = await createAdmin("role-admin");
    const target = await createUser("role-target");
    const actor = await actorFor(admin.headers);

    const result = await setAdminUserRole(
      { actor, headers: admin.headers },
      target.userId,
      ADMIN_ROLE,
    );

    expect(result.roles).toEqual([ADMIN_ROLE]);
    expect(
      (
        await database.user.findUniqueOrThrow({
          where: { id: target.userId },
          select: { role: true },
        })
      ).role,
    ).toBe(ADMIN_ROLE);
  });

  it("refuses changing your own role", async () => {
    const admin = await createAdmin("role-self");
    const actor = await actorFor(admin.headers);

    // Re-asserting the same role never removes the admin role, so the self rule is
    // what answers, whatever the number of administrators happens to be.
    await expect(
      setAdminUserRole(
        { actor, headers: admin.headers },
        admin.userId,
        ADMIN_ROLE,
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses a self demotion while another administrator remains", async () => {
    const admin = await createAdmin("role-self-demote");

    await createAdmin("role-self-demote-other");

    const actor = await actorFor(admin.headers);

    expect(await countOtherAdmins(admin.userId)).toBeGreaterThan(0);
    await expect(
      setAdminUserRole(
        { actor, headers: admin.headers },
        admin.userId,
        USER_ROLE,
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses removing the admin role from the last administrator", async () => {
    const admin = await createAdmin("role-last");
    const actor = await actorFor(admin.headers);

    // Only an administrator may change a role, so the last administrator can only
    // be reached as a target by that administrator. The precondition is created
    // explicitly and then asserted rather than assumed: a stray administrator
    // would make the conflict unobservable, and the suite should say so instead of
    // passing quietly.
    await demoteOtherTestAdmins(admin.userId);

    expect(await countOtherAdmins(admin.userId)).toBe(0);

    await expect(
      setAdminUserRole(
        { actor, headers: admin.headers },
        admin.userId,
        USER_ROLE,
      ),
    ).rejects.toThrow(ConflictError);

    expect(
      (
        await database.user.findUniqueOrThrow({
          where: { id: admin.userId },
          select: { role: true },
        })
      ).role,
    ).toBe(ADMIN_ROLE);
  });

  it("allows demoting an administrator while another one remains", async () => {
    const admin = await createAdmin("role-demote-actor");
    const target = await createAdmin("role-demote-target");
    const actor = await actorFor(admin.headers);

    expect(await countOtherAdmins(target.userId)).toBeGreaterThan(0);
    await expect(
      setAdminUserRole(
        { actor, headers: admin.headers },
        target.userId,
        USER_ROLE,
      ),
    ).resolves.toMatchObject({ roles: [USER_ROLE] });
  });

  it("refuses an unapproved role value", async () => {
    const admin = await createAdmin("role-invalid");
    const target = await createUser("role-invalid-target");
    const actor = await actorFor(admin.headers);

    for (const role of [
      "superadmin",
      "Admin",
      `${ADMIN_ROLE},${USER_ROLE}`,
      `${ADMIN_ROLE},${ADMIN_ROLE}`,
      "",
      "   ",
    ]) {
      await expect(
        setAdminUserRole(
          { actor, headers: admin.headers },
          target.userId,
          role,
        ),
        role,
      ).rejects.toThrow(ValidationError);
    }

    expect(
      (
        await database.user.findUniqueOrThrow({
          where: { id: target.userId },
          select: { role: true },
        })
      ).role,
    ).toBe(USER_ROLE);
  });
});

describe("session revocation", () => {
  it("revokes every session of the target", async () => {
    const admin = await createAdmin("revoke-admin");
    const target = await createUser("revoke-target");
    const secondSession = await signIn(target.userId);
    const actor = await actorFor(admin.headers);

    expect(await getActorFromHeaders(target.headers)).not.toBeNull();
    expect(await getActorFromHeaders(secondSession)).not.toBeNull();

    await revokeAdminUserSessions(
      { actor, headers: admin.headers },
      target.userId,
    );

    expect(await getActorFromHeaders(target.headers)).toBeNull();
    expect(await getActorFromHeaders(secondSession)).toBeNull();
    expect(
      await database.user.findUnique({ where: { id: target.userId } }),
    ).not.toBeNull();
  });

  it("leaves the acting administrator signed in", async () => {
    const admin = await createAdmin("revoke-keeps-admin");
    const target = await createUser("revoke-keeps-target");
    const actor = await actorFor(admin.headers);

    await revokeAdminUserSessions(
      { actor, headers: admin.headers },
      target.userId,
    );

    expect(await getActorFromHeaders(admin.headers)).not.toBeNull();
  });

  it("refuses revoking your own sessions through the target operation", async () => {
    const admin = await createAdmin("revoke-self");
    const actor = await actorFor(admin.headers);

    await expect(
      revokeAdminUserSessions({ actor, headers: admin.headers }, admin.userId),
    ).rejects.toThrow(ForbiddenError);
    expect(await getActorFromHeaders(admin.headers)).not.toBeNull();
  });
});

describe("audit trail", () => {
  it("records exactly one entry for a completed role change", async () => {
    const admin = await createAdmin("audit-role");
    const target = await createUser("audit-role-target");
    const actor = await actorFor(admin.headers);

    await setAdminUserRole(
      { actor, headers: admin.headers },
      target.userId,
      ADMIN_ROLE,
    );

    const records = await auditFor(target.userId);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: "USER_ROLE_SET",
      actorUserId: admin.userId,
      actorSessionId: actor.sessionId,
      targetUserId: target.userId,
      metadata: { role: ADMIN_ROLE },
    });
  });

  it("records exactly one entry for a completed revocation", async () => {
    const admin = await createAdmin("audit-revoke");
    const target = await createUser("audit-revoke-target");
    const actor = await actorFor(admin.headers);

    await revokeAdminUserSessions(
      { actor, headers: admin.headers },
      target.userId,
    );

    const records = await auditFor(target.userId);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: "SESSION_REVOKED",
      actorUserId: admin.userId,
      targetUserId: target.userId,
      metadata: { scope: "all" },
    });
  });

  it("captures the request id when the caller propagates one", async () => {
    const admin = await createAdmin("audit-request-id");
    const target = await createUser("audit-request-id-target");
    const actor = await actorFor(admin.headers);
    const headers = new Headers(admin.headers);

    headers.set("x-request-id", REQUEST_ID);

    await revokeAdminUserSessions({ actor, headers }, target.userId);

    expect((await auditFor(target.userId))[0]?.requestId).toBe(REQUEST_ID);
  });

  it("stores no request id when none was propagated", async () => {
    const admin = await createAdmin("audit-no-request-id");
    const target = await createUser("audit-no-request-id-target");
    const actor = await actorFor(admin.headers);

    await revokeAdminUserSessions(
      { actor, headers: admin.headers },
      target.userId,
    );

    expect((await auditFor(target.userId))[0]?.requestId).toBeNull();
  });

  it("stores no credential, token, address, or personal field", async () => {
    const admin = await createAdmin("audit-minimal");
    const target = await createUser("audit-minimal-target");
    const actor = await actorFor(admin.headers);

    await setAdminUserRole(
      { actor, headers: admin.headers },
      target.userId,
      ADMIN_ROLE,
    );

    const serialized = JSON.stringify(await auditFor(target.userId));

    for (const value of [
      TEST_PASSWORD,
      EMAIL_DOMAIN,
      actor.email,
      admin.headers.get("cookie") ?? "cookie",
      "ipAddress",
      "userAgent",
      "sessionToken",
    ]) {
      expect(serialized.includes(value), value).toBe(false);
    }
  });

  it("records no entry for a refused mutation", async () => {
    const admin = await createAdmin("audit-refused");
    const target = await createUser("audit-refused-target");
    const actor = await actorFor(admin.headers);
    const userActor = await actorFor(target.headers);

    await expect(
      setAdminUserRole(
        { actor: userActor, headers: target.headers },
        admin.userId,
        USER_ROLE,
      ),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      setAdminUserRole(
        { actor, headers: admin.headers },
        target.userId,
        "superadmin",
      ),
    ).rejects.toThrow(ValidationError);
    await expect(
      setAdminUserRole(
        { actor, headers: admin.headers },
        MISSING_USER_ID,
        ADMIN_ROLE,
      ),
    ).rejects.toThrow(NotFoundError);

    expect(await auditFor(target.userId)).toHaveLength(0);
    expect(await auditFor(admin.userId)).toHaveLength(0);
    expect(await auditFor(MISSING_USER_ID)).toHaveLength(0);
  });

  it("reads the trail newest first and requires the capability", async () => {
    const admin = await createAdmin("audit-read");
    const first = await createUser("audit-read-first");
    const second = await createUser("audit-read-second");
    const actor = await actorFor(admin.headers);

    await revokeAdminUserSessions(
      { actor, headers: admin.headers },
      first.userId,
    );
    await setAdminUserRole(
      { actor, headers: admin.headers },
      second.userId,
      ADMIN_ROLE,
    );

    const page = await listAuthorizationAudit(
      { actor, headers: admin.headers },
      { limit: 50 },
    );
    const positions = [first.userId, second.userId].map((userId) =>
      page.records.findIndex((record) => record.targetUserId === userId),
    );

    expect(positions[0]).toBeGreaterThanOrEqual(0);
    expect(positions[1]).toBeGreaterThanOrEqual(0);
    expect(positions[1]).toBeLessThan(positions[0]);

    // The reader contract carries the stable action names, not the storage labels.
    expect(page.records[positions[0]].action).toBe(
      AUDIT_ACTION.SESSION_REVOKED,
    );
    expect(page.records[positions[1]].action).toBe(AUDIT_ACTION.USER_ROLE_SET);

    for (const record of page.records) {
      expect(Object.keys(record).sort()).toEqual([
        "action",
        "actorUserId",
        "id",
        "metadata",
        "occurredAt",
        "requestId",
        "targetUserId",
      ]);
    }

    // A user whose sessions this test did not revoke, so the refusal is about the
    // missing capability rather than a missing session.
    const reader = await createUser("audit-read-reader");

    await expect(
      listAuthorizationAudit(
        { actor: await actorFor(reader.headers), headers: reader.headers },
        { limit: 10 },
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("bounds the page it returns", async () => {
    const admin = await createAdmin("audit-bounded");
    const actor = await actorFor(admin.headers);
    const page = await listAuthorizationAudit(
      { actor, headers: admin.headers },
      { limit: 1 },
    );

    expect(page.limit).toBe(1);
    expect(page.records.length).toBeLessThanOrEqual(1);
  });
});

describe("object-level protection", () => {
  it("answers a normal user identically for an existing and a missing target", async () => {
    const admin = await createAdmin("bola-admin");
    const attacker = await createUser("bola-attacker");
    const actor = await actorFor(attacker.headers);
    const context = { actor, headers: attacker.headers };

    for (const targetUserId of [admin.userId, MISSING_USER_ID]) {
      await expect(getAdminUser(context, targetUserId)).rejects.toThrow(
        ForbiddenError,
      );
      await expect(
        setAdminUserRole(context, targetUserId, ADMIN_ROLE),
      ).rejects.toThrow(ForbiddenError);
      await expect(
        revokeAdminUserSessions(context, targetUserId),
      ).rejects.toThrow(ForbiddenError);
    }

    await expect(
      listAdminUsers(context, {
        limit: 20,
        offset: 0,
        sortBy: "createdAt",
        sortDirection: "desc",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses a normal user before a policy could disclose record state", async () => {
    const attacker = await createUser("bola-policy");
    const lastAdmin = await createAdmin("bola-last-admin");
    const actor = await actorFor(attacker.headers);

    // Demoting the last administrator would be a conflict for an authorized
    // caller. An unauthorized one must not be able to tell.
    await expect(
      setAdminUserRole(
        { actor, headers: attacker.headers },
        lastAdmin.userId,
        USER_ROLE,
      ),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("direct Better Auth admin endpoints", () => {
  /**
   * Calls a Better Auth admin endpoint the way an external client would: through
   * the real HTTP handler, with a real cookie and a real origin.
   */
  async function callAdminEndpoint(
    sessionHeaders: Headers,
    path: string,
    options: { body: string; requestId?: string },
  ) {
    const headers = new Headers({
      "content-type": "application/json",
      cookie: sessionHeaders.get("cookie") ?? "",
      origin: "http://localhost",
    });

    if (options.requestId) {
      headers.set("x-request-id", options.requestId);
    }

    return auth.handler(
      new Request(`http://localhost/api/auth${path}`, {
        method: "POST",
        headers,
        body: options.body,
      }),
    );
  }

  it("refuses every unsupported operation for an administrator", async () => {
    const admin = await createAdmin("direct-unsupported");
    const target = await createUser("direct-unsupported-target");
    const unsupported = [
      {
        path: "/admin/create-user",
        body: {
          email: uniqueEmail("created"),
          password: TEST_PASSWORD,
          name: "X",
        },
      },
      { path: "/admin/update-user", body: { userId: target.userId, data: {} } },
      { path: "/admin/remove-user", body: { userId: target.userId } },
      { path: "/admin/ban-user", body: { userId: target.userId } },
      { path: "/admin/unban-user", body: { userId: target.userId } },
      { path: "/admin/impersonate-user", body: { userId: target.userId } },
      {
        path: "/admin/set-user-password",
        body: { userId: target.userId, newPassword: "another-test-password" },
      },
      { path: "/admin/list-user-sessions", body: { userId: target.userId } },
      { path: "/admin/revoke-user-session", body: { sessionToken: "token" } },
      { path: "/admin/stop-impersonating", body: {} },
    ];

    for (const { path, body } of unsupported) {
      const response = await callAdminEndpoint(admin.headers, path, {
        body: JSON.stringify(body),
      });

      expect(response.status, path).toBe(403);
    }

    expect(
      await database.user.findUnique({ where: { id: target.userId } }),
    ).not.toBeNull();
  });

  it("refuses every administrative endpoint for a normal user", async () => {
    const user = await createUser("direct-user-role");
    const target = await createUser("direct-user-role-target");

    for (const { path, body } of [
      {
        path: "/admin/set-role",
        body: { userId: target.userId, role: ADMIN_ROLE },
      },
      { path: "/admin/revoke-user-sessions", body: { userId: target.userId } },
      {
        path: "/admin/create-user",
        body: { email: uniqueEmail("x"), name: "X" },
      },
      { path: "/admin/ban-user", body: { userId: target.userId } },
    ]) {
      const response = await callAdminEndpoint(user.headers, path, {
        body: JSON.stringify(body),
      });

      expect(response.status, path).toBe(403);
    }

    const listResponse = await auth.handler(
      new Request("http://localhost/api/auth/admin/list-users", {
        headers: new Headers({ cookie: user.headers.get("cookie") ?? "" }),
      }),
    );

    expect(listResponse.status).toBe(403);
  });

  it("refuses every administrative endpoint without a session", async () => {
    const response = await callAdminEndpoint(new Headers(), "/admin/set-role", {
      body: JSON.stringify({ userId: MISSING_USER_ID, role: ADMIN_ROLE }),
    });

    expect(response.status).toBe(401);
  });

  it("applies the self-target policy to a direct role change", async () => {
    const admin = await createAdmin("direct-self-role");
    const response = await callAdminEndpoint(admin.headers, "/admin/set-role", {
      body: JSON.stringify({ userId: admin.userId, role: USER_ROLE }),
    });

    expect(response.status).toBe(403);
    expect(
      (
        await database.user.findUniqueOrThrow({
          where: { id: admin.userId },
          select: { role: true },
        })
      ).role,
    ).toBe(ADMIN_ROLE);
  });

  it("applies the self-target policy to a direct revocation", async () => {
    const admin = await createAdmin("direct-self-revoke");
    const response = await callAdminEndpoint(
      admin.headers,
      "/admin/revoke-user-sessions",
      { body: JSON.stringify({ userId: admin.userId }) },
    );

    expect(response.status).toBe(403);
    expect(await getActorFromHeaders(admin.headers)).not.toBeNull();
  });

  it("applies the role allowlist to a direct role change", async () => {
    const admin = await createAdmin("direct-invalid-role");
    const target = await createUser("direct-invalid-role-target");

    for (const role of [
      "superadmin",
      [ADMIN_ROLE],
      `${ADMIN_ROLE},${USER_ROLE}`,
    ]) {
      const response = await callAdminEndpoint(
        admin.headers,
        "/admin/set-role",
        { body: JSON.stringify({ userId: target.userId, role }) },
      );

      expect(response.status, JSON.stringify(role)).toBe(400);
    }

    expect(
      (
        await database.user.findUniqueOrThrow({
          where: { id: target.userId },
          select: { role: true },
        })
      ).role,
    ).toBe(USER_ROLE);
  });

  it("answers not found for a missing target without disclosing it to others", async () => {
    const admin = await createAdmin("direct-missing");
    const attacker = await createUser("direct-missing-attacker");

    expect(
      (
        await callAdminEndpoint(admin.headers, "/admin/set-role", {
          body: JSON.stringify({ userId: MISSING_USER_ID, role: ADMIN_ROLE }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await callAdminEndpoint(attacker.headers, "/admin/set-role", {
          body: JSON.stringify({ userId: MISSING_USER_ID, role: ADMIN_ROLE }),
        })
      ).status,
    ).toBe(403);
  });

  it("records exactly one audit entry for a direct mutation", async () => {
    const admin = await createAdmin("direct-audit");
    const target = await createUser("direct-audit-target");
    const response = await callAdminEndpoint(
      admin.headers,
      "/admin/revoke-user-sessions",
      {
        body: JSON.stringify({ userId: target.userId }),
        requestId: REQUEST_ID,
      },
    );

    expect(response.status).toBe(200);

    const records = await auditFor(target.userId);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: "SESSION_REVOKED",
      actorUserId: admin.userId,
      targetUserId: target.userId,
      requestId: REQUEST_ID,
      metadata: { scope: "all" },
    });
  });

  it("records no audit entry for a refused direct mutation", async () => {
    const admin = await createAdmin("direct-audit-refused");
    const target = await createUser("direct-audit-refused-target");

    await callAdminEndpoint(admin.headers, "/admin/set-role", {
      body: JSON.stringify({ userId: target.userId, role: "superadmin" }),
    });
    await callAdminEndpoint(admin.headers, "/admin/ban-user", {
      body: JSON.stringify({ userId: target.userId }),
    });

    expect(await auditFor(target.userId)).toHaveLength(0);
  });

  it("reports the caller's own permissions and nobody else's", async () => {
    const admin = await createAdmin("direct-has-permission");
    const user = await createUser("direct-has-permission-user");

    const adminResponse = await callAdminEndpoint(
      admin.headers,
      "/admin/has-permission",
      {
        body: JSON.stringify({ permissions: { "identity.admin": ["access"] } }),
      },
    );

    expect(adminResponse.status).toBe(200);
    expect(await adminResponse.json()).toMatchObject({ success: true });

    // A user id in the body cannot borrow another account's capabilities.
    const userResponse = await callAdminEndpoint(
      user.headers,
      "/admin/has-permission",
      {
        body: JSON.stringify({
          userId: admin.userId,
          permissions: { "identity.admin": ["access"] },
        }),
      },
    );

    expect(userResponse.status).toBe(200);
    expect(await userResponse.json()).toMatchObject({ success: false });

    const anonymousResponse = await callAdminEndpoint(
      new Headers(),
      "/admin/has-permission",
      {
        body: JSON.stringify({
          userId: admin.userId,
          permissions: { "identity.admin": ["access"] },
        }),
      },
    );

    expect(anonymousResponse.status).toBe(401);
  });
});
