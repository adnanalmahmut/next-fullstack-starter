import { loadEnvConfig } from "@next/env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

loadEnvConfig(process.cwd());

vi.doMock("server-only", () => ({}));

const { auth } = await import("@/platform/auth/auth.server");
const { getSessionFromHeaders, toSessionViewer } =
  await import("@/platform/auth/session.server");
const { isEmailRegistrationEnabled } =
  await import("@/platform/auth/registration-policy");
const { database } = await import("@/platform/database/index.server");

const TEST_PASSWORD = "integration-test-only-password";
const createdUserIds: string[] = [];

/**
 * Cleanup is bounded to the rows this file created, and it only runs after the
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
  return `auth-${label}-${crypto.randomUUID()}@example.test`;
}

async function signUp(email: string, name = "Integration User") {
  const response = await auth.api.signUpEmail({
    body: {
      email,
      password: TEST_PASSWORD,
      name,
    },
    asResponse: true,
  });

  if (response.ok) {
    const body = (await response.clone().json()) as {
      user?: { id?: string };
    };

    if (body.user?.id) {
      createdUserIds.push(body.user.id);
    }
  }

  return response;
}

async function signIn(email: string, password = TEST_PASSWORD) {
  return auth.api.signInEmail({
    body: {
      email,
      password,
    },
    asResponse: true,
  });
}

function sessionCookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

function headersWithCookie(cookie: string): Headers {
  return new Headers({
    cookie,
  });
}

beforeAll(() => {
  assertTestDatabase();
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // Child rows first, then the parent, so the cleanup does not rely on cascade.
    await database.session.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await database.account.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await database.user.deleteMany({
      where: { id: { in: createdUserIds } },
    });
  }

  await database.$disconnect();
});

describe("registration policy", () => {
  it("enables email sign-up in the test environment", async () => {
    expect(isEmailRegistrationEnabled("test")).toBe(true);

    const response = await signUp(uniqueEmail("signup"));

    expect(response.status).toBe(200);
  });

  it("rejects a duplicate email address", async () => {
    const email = uniqueEmail("duplicate");

    expect((await signUp(email)).status).toBe(200);
    expect((await signUp(email)).ok).toBe(false);
  });

  it("refuses a role supplied through sign-up input", async () => {
    const response = await auth.api.signUpEmail({
      body: {
        email: uniqueEmail("role-injection"),
        password: TEST_PASSWORD,
        name: "Role Injection",
        role: "admin",
      } as never,
      asResponse: true,
    });

    expect(response.ok).toBe(false);

    const body = (await response.json()) as { code?: string };

    expect(body.code).toBe("FIELD_NOT_ALLOWED");
  });

  it("assigns the default role on the server", async () => {
    const email = uniqueEmail("default-role");

    await signUp(email);

    const user = await database.user.findUnique({
      where: { email },
      select: { role: true, banned: true },
    });

    expect(user?.role).toBe("user");
    expect(user?.banned).toBe(false);
  });

  it("stores a hashed credential password on the account", async () => {
    const email = uniqueEmail("hash");

    await signUp(email);

    const user = await database.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });
    const account = await database.account.findFirstOrThrow({
      where: { userId: user.id },
      select: { providerId: true, password: true },
    });

    expect(account.providerId).toBe("credential");
    expect(account.password).not.toBe(TEST_PASSWORD);
    expect(account.password?.length ?? 0).toBeGreaterThan(60);
  });
});

describe("sign-in", () => {
  it("creates a database-backed session for valid credentials", async () => {
    const email = uniqueEmail("valid-signin");

    await signUp(email);

    const response = await signIn(email);

    expect(response.status).toBe(200);

    const cookie = sessionCookieHeader(response);

    expect(cookie).toContain("session_token");

    const session = await getSessionFromHeaders(headersWithCookie(cookie));

    expect(session?.user.email).toBe(email);

    const stored = await database.session.findFirst({
      where: { userId: session?.user.id },
      select: { token: true, expiresAt: true },
    });

    expect(stored?.token).toBeTruthy();
    expect(stored?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("issues an HttpOnly, SameSite session cookie", async () => {
    const email = uniqueEmail("cookie-flags");

    await signUp(email);

    const setCookie = (await signIn(email)).headers
      .getSetCookie()
      .find((cookie) => cookie.includes("session_token"));

    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toContain(TEST_PASSWORD);
  });

  it("rejects an incorrect password without creating a session", async () => {
    const email = uniqueEmail("wrong-password");

    await signUp(email);

    const user = await database.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });
    // Scoped to this account, so a concurrent suite creating its own sessions
    // cannot change the result.
    const where = { userId: user.id };
    const before = await database.session.count({ where });
    const response = await signIn(email, "definitely-not-the-password");

    expect(response.status).toBe(401);
    expect(sessionCookieHeader(response)).not.toContain("session_token");
    expect(await database.session.count({ where })).toBe(before);
  });

  it("does not distinguish an unknown address from a wrong password", async () => {
    const email = uniqueEmail("enumeration");

    await signUp(email);

    const wrongPassword = await signIn(email, "definitely-not-the-password");
    const unknownAddress = await signIn(uniqueEmail("missing"));

    expect(unknownAddress.status).toBe(wrongPassword.status);
    expect(await unknownAddress.json()).toEqual(await wrongPassword.json());
  });
});

describe("session validation", () => {
  it("returns null without a cookie", async () => {
    expect(await getSessionFromHeaders(new Headers())).toBeNull();
  });

  it("returns null for a fabricated cookie", async () => {
    const forged = headersWithCookie(
      "better-auth.session_token=forged-value-that-was-never-issued",
    );

    expect(await getSessionFromHeaders(forged)).toBeNull();
  });

  it("returns null once the stored session expired", async () => {
    const email = uniqueEmail("expired");

    await signUp(email);

    const cookie = sessionCookieHeader(await signIn(email));
    const session = await getSessionFromHeaders(headersWithCookie(cookie));

    expect(session).not.toBeNull();

    await database.session.updateMany({
      where: { userId: session?.user.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    expect(await getSessionFromHeaders(headersWithCookie(cookie))).toBeNull();
  });

  it("returns null once the stored session is revoked", async () => {
    const email = uniqueEmail("revoked");

    await signUp(email);

    const cookie = sessionCookieHeader(await signIn(email));
    const session = await getSessionFromHeaders(headersWithCookie(cookie));

    await database.session.deleteMany({
      where: { userId: session?.user.id },
    });

    expect(await getSessionFromHeaders(headersWithCookie(cookie))).toBeNull();
  });
});

describe("session presentation", () => {
  it("exposes only display fields for an authenticated session", async () => {
    const email = uniqueEmail("viewer");

    await signUp(email);

    const cookie = sessionCookieHeader(await signIn(email));
    const session = await getSessionFromHeaders(headersWithCookie(cookie));
    const viewer = toSessionViewer(session);

    expect(Object.keys(viewer ?? {}).sort()).toEqual(["email", "id", "name"]);
    expect(viewer?.email).toBe(email);
    expect(JSON.stringify(viewer)).not.toContain(TEST_PASSWORD);
  });

  it("returns null without a session", () => {
    expect(toSessionViewer(null)).toBeNull();
  });
});

describe("sign-out", () => {
  it("revokes the current session and leaves the user intact", async () => {
    const email = uniqueEmail("signout");

    await signUp(email);

    const cookie = sessionCookieHeader(await signIn(email));
    const session = await getSessionFromHeaders(headersWithCookie(cookie));
    const userId = session?.user.id;

    expect(userId).toBeTruthy();

    const response = await auth.api.signOut({
      headers: headersWithCookie(cookie),
      asResponse: true,
    });

    expect(response.status).toBe(200);

    // The same cookie must not resolve a session after sign-out.
    expect(await getSessionFromHeaders(headersWithCookie(cookie))).toBeNull();

    expect(
      await database.user.findUnique({ where: { id: userId } }),
    ).not.toBeNull();
  });

  it("keeps other sessions of the same user usable", async () => {
    const email = uniqueEmail("other-sessions");

    await signUp(email);

    const firstCookie = sessionCookieHeader(await signIn(email));
    const secondCookie = sessionCookieHeader(await signIn(email));

    await auth.api.signOut({
      headers: headersWithCookie(firstCookie),
      asResponse: true,
    });

    expect(
      await getSessionFromHeaders(headersWithCookie(firstCookie)),
    ).toBeNull();
    expect(
      await getSessionFromHeaders(headersWithCookie(secondCookie)),
    ).not.toBeNull();
  });
});

describe("admin plugin foundation", () => {
  it("keeps administrative fields on the schema", async () => {
    const email = uniqueEmail("admin-fields");

    await signUp(email);

    const user = await database.user.findUniqueOrThrow({
      where: { email },
      select: {
        role: true,
        banned: true,
        banReason: true,
        banExpires: true,
      },
    });

    expect(user).toEqual({
      role: "user",
      banned: false,
      banReason: null,
      banExpires: null,
    });
  });

  it("refuses an administrative operation for a default user", async () => {
    const email = uniqueEmail("admin-denied");

    await signUp(email);

    const cookie = sessionCookieHeader(await signIn(email));

    // The authorization guard refuses the endpoint before it runs, so a direct
    // `auth.api` call rejects rather than resolving to an error response. Over
    // HTTP the router turns the same refusal into a 403.
    const response = await auth.handler(
      new Request("http://localhost/api/auth/admin/list-users", {
        headers: headersWithCookie(cookie),
      }),
    );

    expect(response.ok).toBe(false);
    expect([401, 403]).toContain(response.status);
  });
});
