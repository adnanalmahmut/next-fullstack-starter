import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const TEST_PASSWORD = "e2e-test-only-password";
const sessionCookiePattern = /better-auth\.session_token$/;

type TestAccount = {
  readonly email: string;
  readonly name: string;
};

function uniqueAccount(label: string): TestAccount {
  return {
    email: `e2e-${label}-${crypto.randomUUID()}@example.test`,
    name: `E2E ${label}`,
  };
}

/**
 * Accounts are provisioned through Better Auth itself, which is enabled for
 * `APP_ENV=test`. No password hash is written by hand and no account is shared
 * between flows.
 */
async function provisionAccount(
  request: APIRequestContext,
  baseURL: string,
  account: TestAccount,
) {
  const response = await request.post("/api/auth/sign-up/email", {
    headers: {
      origin: baseURL,
    },
    data: {
      email: account.email,
      password: TEST_PASSWORD,
      name: account.name,
    },
  });

  expect(response.status(), await response.text()).toBe(200);
}

async function submitCredentials(
  page: Page,
  emailLabel: RegExp | string,
  passwordLabel: RegExp | string,
  submitLabel: RegExp | string,
  email: string,
  password: string,
) {
  await page.getByLabel(emailLabel).fill(email);
  await page.getByLabel(passwordLabel).fill(password);
  await page.getByRole("button", { name: submitLabel }).click();
}

type BrowserCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];

function sessionCookie(
  cookies: readonly BrowserCookie[],
): BrowserCookie | undefined {
  return cookies.find((cookie) => sessionCookiePattern.test(cookie.name));
}

test.describe("authentication", () => {
  test("completes the Arabic sign-in journey", async ({
    page,
    context,
    request,
    baseURL,
  }) => {
    const account = uniqueAccount("ar");

    await provisionAccount(request, baseURL ?? "", account);

    // An unauthenticated visit is redirected by the server, not by the client.
    await page.goto("/ar/account");
    await expect(page).toHaveURL(/\/ar\/login\?returnTo=%2Far%2Faccount$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(
      page.getByRole("heading", { level: 1, name: "تسجيل الدخول" }),
    ).toBeVisible();

    await submitCredentials(
      page,
      "البريد الإلكتروني",
      "كلمة المرور",
      "تسجيل الدخول",
      account.email,
      "definitely-not-the-password",
    );

    // Next.js renders its own route announcer with role="alert", so the form's
    // error region is addressed by its explicit slot.
    const alert = page.locator('[data-slot="login-error"]');

    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert).toContainText(
      "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
    );
    await expect(page).toHaveURL(/\/ar\/login/);
    expect(sessionCookie(await context.cookies())).toBeUndefined();

    await submitCredentials(
      page,
      "البريد الإلكتروني",
      "كلمة المرور",
      "تسجيل الدخول",
      account.email,
      TEST_PASSWORD,
    );

    await expect(page).toHaveURL(/\/ar\/account$/);
    await expect(page.locator('[data-slot="account-email"]')).toHaveText(
      account.email,
    );
    await expect(page.locator('[data-slot="account-email"]')).toHaveAttribute(
      "dir",
      "ltr",
    );

    // The session survives a full reload because it is validated server-side.
    await page.reload();
    await expect(page).toHaveURL(/\/ar\/account$/);
    await expect(page.locator('[data-slot="account-email"]')).toHaveText(
      account.email,
    );

    // Navigated by the browser so the real session cookie is presented; the
    // handler resolves the session on the server.
    const diagnostic = await page.goto("/api/diagnostics/auth-session");

    expect(await diagnostic?.json()).toEqual({
      authenticated: true,
      user: {
        id: expect.any(String),
        email: account.email,
      },
    });

    await page.goto("/ar/account");
    await page.getByRole("button", { name: "تسجيل الخروج" }).click();
    await expect(page).toHaveURL(/\/ar\/login$/);

    await page.goto("/ar/account");
    await expect(page).toHaveURL(/\/ar\/login\?returnTo=%2Far%2Faccount$/);

    const revoked = await page.goto("/api/diagnostics/auth-session");

    expect(await revoked?.json()).toEqual({
      authenticated: false,
    });
  });

  test("completes the English sign-in journey", async ({
    page,
    request,
    baseURL,
  }) => {
    const account = uniqueAccount("en");

    await provisionAccount(request, baseURL ?? "", account);

    await page.goto("/en/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in" }),
    ).toBeVisible();

    await submitCredentials(
      page,
      "Email address",
      "Password",
      "Sign in",
      account.email,
      TEST_PASSWORD,
    );

    await expect(page).toHaveURL(/\/en\/account$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Your account" }),
    ).toBeVisible();
    await expect(page.locator('[data-slot="account-email"]')).toHaveText(
      account.email,
    );

    const diagnostic = await page.goto("/api/diagnostics/auth-session");

    expect(await diagnostic?.json()).toEqual({
      authenticated: true,
      user: {
        id: expect.any(String),
        email: account.email,
      },
    });

    await page.goto("/en/account");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/en\/login$/);

    const revoked = await page.goto("/api/diagnostics/auth-session");

    expect(await revoked?.json()).toEqual({
      authenticated: false,
    });
  });

  test("keeps an authenticated visitor away from the login page", async ({
    page,
    request,
    baseURL,
  }) => {
    const account = uniqueAccount("signed-in");

    await provisionAccount(request, baseURL ?? "", account);

    await page.goto("/en/login");
    await submitCredentials(
      page,
      "Email address",
      "Password",
      "Sign in",
      account.email,
      TEST_PASSWORD,
    );

    await expect(page).toHaveURL(/\/en\/account$/);

    await page.goto("/en/login");
    await expect(page).toHaveURL(/\/en\/account$/);
  });

  test("issues a hardened session cookie and stores nothing in the browser", async ({
    page,
    context,
    request,
    baseURL,
  }) => {
    const account = uniqueAccount("cookie");

    await provisionAccount(request, baseURL ?? "", account);

    await page.goto("/en/login");
    await submitCredentials(
      page,
      "Email address",
      "Password",
      "Sign in",
      account.email,
      TEST_PASSWORD,
    );
    await expect(page).toHaveURL(/\/en\/account$/);

    const cookies = await context.cookies();
    const session = sessionCookie(cookies);

    expect(session).toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Lax");
    expect(session?.path).toBe("/");

    for (const cookie of cookies) {
      expect(cookie.value).not.toContain(TEST_PASSWORD);
    }

    const storage = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));

    expect(storage.local).toEqual([]);
    expect(storage.session).toEqual([]);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/en\/login$/);

    expect(sessionCookie(await context.cookies())).toBeUndefined();
  });

  test("refuses a hostile return path", async ({ page, request, baseURL }) => {
    const account = uniqueAccount("return-to");

    await provisionAccount(request, baseURL ?? "", account);

    await page.goto("/en/login?returnTo=https://attacker.example");
    await submitCredentials(
      page,
      "Email address",
      "Password",
      "Sign in",
      account.email,
      TEST_PASSWORD,
    );

    await expect(page).toHaveURL(/\/en\/account$/);
    expect(new URL(page.url()).origin).toBe(new URL(baseURL ?? "").origin);
  });

  test("rejects a role supplied to the sign-up endpoint", async ({
    request,
    baseURL,
  }) => {
    const account = uniqueAccount("role");
    const response = await request.post("/api/auth/sign-up/email", {
      headers: {
        origin: baseURL ?? "",
      },
      data: {
        email: account.email,
        password: TEST_PASSWORD,
        name: account.name,
        role: "admin",
      },
    });

    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "FIELD_NOT_ALLOWED",
    });
  });

  test("rejects invalid credentials at the endpoint without a session", async ({
    request,
    baseURL,
  }) => {
    const account = uniqueAccount("endpoint");

    await provisionAccount(request, baseURL ?? "", account);

    const wrongPassword = await request.post("/api/auth/sign-in/email", {
      headers: { origin: baseURL ?? "" },
      data: { email: account.email, password: "definitely-not-the-password" },
      failOnStatusCode: false,
    });
    const unknownAddress = await request.post("/api/auth/sign-in/email", {
      headers: { origin: baseURL ?? "" },
      data: {
        email: `missing-${crypto.randomUUID()}@example.test`,
        password: TEST_PASSWORD,
      },
      failOnStatusCode: false,
    });

    expect(wrongPassword.status()).toBe(401);
    expect(unknownAddress.status()).toBe(401);
    expect(await unknownAddress.json()).toEqual(await wrongPassword.json());
    expect(
      wrongPassword
        .headersArray()
        .filter(({ name }) => name.toLowerCase() === "set-cookie"),
    ).toEqual([]);
  });

  test("rejects a cross-origin authentication request", async ({ request }) => {
    const response = await request.post("/api/auth/sign-in/email", {
      headers: {
        origin: "https://attacker.example",
      },
      data: {
        email: "anyone@example.test",
        password: TEST_PASSWORD,
      },
      failOnStatusCode: false,
    });

    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "INVALID_ORIGIN",
    });
  });

  test("keeps the proxy contract on authentication responses", async ({
    request,
  }) => {
    const requestIdPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    for (const pathname of [
      "/ar/login",
      "/api/auth/get-session",
      "/api/diagnostics/auth-session",
    ]) {
      const response = await request.get(pathname, { maxRedirects: 0 });
      const headers = response.headers();

      expect(headers["x-content-type-options"], pathname).toBe("nosniff");
      expect(headers["referrer-policy"], pathname).toBe(
        "strict-origin-when-cross-origin",
      );
      expect(headers["x-frame-options"], pathname).toBe("DENY");
      expect(headers["permissions-policy"], pathname).toBe(
        "camera=(), microphone=(), geolocation=()",
      );
      expect(headers["x-request-id"], pathname).toMatch(requestIdPattern);
    }
  });

  test("leaves the existing locale behaviour unchanged", async ({
    page,
    request,
  }) => {
    const rootRedirect = await request.get("/", { maxRedirects: 0 });

    expect(rootRedirect.status()).toBe(307);
    expect(rootRedirect.headers()["location"]).toBe("/ar");

    await page.goto("/ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    await page.goto("/en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    expect((await request.get("/ar/design-system")).status()).toBe(200);
  });
});
