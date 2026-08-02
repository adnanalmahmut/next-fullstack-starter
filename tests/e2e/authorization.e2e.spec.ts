import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  findAuditRows,
  findLegacyAuditRowCount,
  findTestUserId,
  grantAdminRole,
  makeSoleAdmin,
  removeTestAccounts,
  TEST_PASSWORD,
  uniqueTestEmail,
} from "./authorization-fixture";

const MISSING_USER_ID = "missing-00000000-0000-4000-8000-000000000000";

type Account = {
  readonly email: string;
  readonly userId: string;
};

async function signUp(
  request: APIRequestContext,
  baseURL: string,
  label: string,
): Promise<Account> {
  const email = uniqueTestEmail(label);
  const response = await request.post("/api/auth/sign-up/email", {
    headers: { origin: baseURL },
    data: { email, password: TEST_PASSWORD, name: `Authz ${label}` },
  });

  expect(response.status(), await response.text()).toBe(200);

  return { email, userId: await findTestUserId(email) };
}

async function signUpAdmin(
  request: APIRequestContext,
  baseURL: string,
  label: string,
): Promise<Account> {
  const account = await signUp(request, baseURL, label);

  await grantAdminRole(account.email);

  return account;
}

async function signIn(page: Page, locale: string, account: Account) {
  const copy =
    locale === "ar"
      ? {
          email: "البريد الإلكتروني",
          password: "كلمة المرور",
          submit: "تسجيل الدخول",
        }
      : { email: "Email address", password: "Password", submit: "Sign in" };

  await page.goto(`/${locale}/login`);
  await page.getByLabel(copy.email).fill(account.email);
  await page.getByLabel(copy.password).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: copy.submit }).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/account$`));
}

/**
 * Reads a JSON response through the browser, so the real session cookie is sent.
 * Playwright's API context does not carry a `__Secure-` prefixed cookie over
 * plain HTTP.
 */
async function readJson(page: Page, path: string) {
  const response = await page.goto(path);

  return {
    status: response?.status() ?? 0,
    body: (await response?.json()) as unknown,
  };
}

async function sendJson(
  page: Page,
  method: "PATCH" | "POST",
  path: string,
  body?: unknown,
) {
  return page.evaluate(
    async ([requestMethod, requestPath, requestBody]) => {
      const response = await fetch(requestPath as string, {
        method: requestMethod as string,
        headers: { "content-type": "application/json" },
        ...(requestBody === null ? {} : { body: JSON.stringify(requestBody) }),
      });

      // Every `/api/v1` answer is a JSON envelope, including one with no
      // payload; there is no empty-body status to special case.
      return {
        status: response.status,
        body: await response.json(),
      };
    },
    [method, path, body ?? null] as const,
  );
}

// The suite owns the global administrator count, so its cases run in order and
// each one provisions the accounts it needs.
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await removeTestAccounts();
});

test.afterAll(async () => {
  await removeTestAccounts();
});

test.describe("authorization", () => {
  test("refuses the administration area to a visitor without a session", async ({
    page,
    request,
    baseURL,
  }) => {
    const admin = await signUpAdmin(request, baseURL ?? "", "anon-target");

    await page.goto("/ar/admin");
    await expect(page).toHaveURL(/\/ar\/login\?returnTo=%2Far%2Fadmin$/);

    await page.goto("/en/admin/users");
    await expect(page).toHaveURL(/\/en\/login\?returnTo=%2Fen%2Fadmin$/);

    // An existing and a missing identifier answer identically.
    for (const userId of [admin.userId, MISSING_USER_ID]) {
      expect(
        (await readJson(page, `/api/v1/admin/users/${userId}`)).status,
      ).toBe(401);
    }

    expect((await readJson(page, "/api/v1/admin/users")).status).toBe(401);
    expect((await readJson(page, "/api/v1/admin/audit")).status).toBe(401);
  });

  test("refuses the administration area to a normal user in Arabic", async ({
    page,
    request,
    baseURL,
  }) => {
    const user = await signUp(request, baseURL ?? "", "denied-ar");
    const admin = await signUpAdmin(request, baseURL ?? "", "denied-ar-target");

    await signIn(page, "ar", user);
    await page.goto("/ar/admin");

    await expect(page).toHaveURL(/\/ar\/admin$/);
    await expect(page.locator('[data-slot="admin-forbidden"]')).toContainText(
      "الوصول مقيَّد",
    );
    await expect(page.locator('[data-slot="admin-area-header"]')).toHaveCount(
      0,
    );
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    // Neither the existing nor the missing identifier reveals anything.
    for (const userId of [admin.userId, MISSING_USER_ID]) {
      const read = await readJson(page, `/api/v1/admin/users/${userId}`);

      expect(read.status).toBe(403);
      expect(read.body).toEqual({ error: { code: "FORBIDDEN" } });

      expect(
        (
          await sendJson(page, "PATCH", `/api/v1/admin/users/${userId}/role`, {
            role: "admin",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await sendJson(
            page,
            "POST",
            `/api/v1/admin/users/${userId}/sessions/revoke`,
          )
        ).status,
      ).toBe(403);
    }

    expect((await readJson(page, "/api/v1/admin/users")).status).toBe(403);
    expect((await readJson(page, "/api/v1/admin/audit")).status).toBe(403);
  });

  test("refuses the administration area to a normal user in English", async ({
    page,
    request,
    baseURL,
  }) => {
    const user = await signUp(request, baseURL ?? "", "denied-en");

    await signIn(page, "en", user);
    await page.goto("/en/admin/audit");

    await expect(page.locator('[data-slot="admin-forbidden"]')).toContainText(
      "Access is restricted",
    );
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.locator('[data-slot="admin-audit-list"]')).toHaveCount(0);
  });

  test("cannot reach a Better Auth admin endpoint as a normal user", async ({
    page,
    request,
    baseURL,
  }) => {
    const user = await signUp(request, baseURL ?? "", "direct-denied");
    const target = await signUp(request, baseURL ?? "", "direct-denied-target");

    await signIn(page, "en", user);

    expect(
      (
        await sendJson(page, "POST", "/api/auth/admin/set-role", {
          userId: target.userId,
          role: "admin",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await sendJson(page, "POST", "/api/auth/admin/ban-user", {
          userId: target.userId,
        })
      ).status,
    ).toBe(403);
    expect((await readJson(page, "/api/auth/admin/list-users")).status).toBe(
      403,
    );
  });

  test("lets an administrator work through the area in Arabic", async ({
    page,
    request,
    baseURL,
  }) => {
    const legacyRowsBefore = await findLegacyAuditRowCount();
    const admin = await signUpAdmin(request, baseURL ?? "", "flow-ar");
    const target = await signUp(request, baseURL ?? "", "flow-ar-target");
    const consoleErrors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });

    await signIn(page, "ar", admin);

    await page.goto("/ar/admin");
    await expect(
      page.getByRole("heading", { level: 1, name: "الإدارة" }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(
      page.getByRole("navigation", { name: "الإدارة" }),
    ).toBeVisible();

    await page.getByRole("link", { name: "المستخدمون" }).click();
    await expect(page).toHaveURL(/\/ar\/admin\/users$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "المستخدمون" }),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="admin-user-row"]').first(),
    ).toBeVisible();

    await page.getByRole("link", { name: "سجل التدقيق" }).click();
    await expect(page).toHaveURL(/\/ar\/admin\/audit$/);
    await expect(
      page.locator('[data-slot="admin-audit-list-empty"]'),
    ).toBeVisible();

    // Browsing the area produces no console error. The assertion is made here,
    // before this test deliberately asks for a missing record: the browser reports
    // any non-2xx resource as a console error, including one the test wanted.
    expect(consoleErrors).toEqual([]);

    // Read the target through the API, using the browser session.
    const read = await readJson(page, `/api/v1/admin/users/${target.userId}`);

    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      data: { id: target.userId, roles: ["user"] },
    });
    expect(JSON.stringify(read.body)).not.toContain("password");

    expect(
      (await readJson(page, `/api/v1/admin/users/${MISSING_USER_ID}`)).status,
    ).toBe(404);

    // Change the role, then see the record appear in the trail.
    const roleChange = await sendJson(
      page,
      "PATCH",
      `/api/v1/admin/users/${target.userId}/role`,
      { role: "admin" },
    );

    expect(roleChange.status).toBe(200);
    expect(roleChange.body).toMatchObject({ data: { roles: ["admin"] } });

    await page.goto("/ar/admin/audit");
    await expect(
      page.locator('[data-action="identity.user.role-set"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-action="identity.user.role-set"]'),
    ).toContainText("تغيير الدور");

    expect(await findAuditRows(target.userId)).toHaveLength(1);

    // Revoke the target's sessions, then see the second record appear.
    const revoke = await sendJson(
      page,
      "POST",
      `/api/v1/admin/users/${target.userId}/sessions/revoke`,
    );

    expect(revoke.status).toBe(200);
    expect(revoke.body).toEqual({ data: null });

    await page.goto("/ar/admin/audit");

    const revokedRow = page.locator('[data-action="identity.session.revoked"]');

    await expect(revokedRow).toHaveCount(1);
    await expect(revokedRow).toHaveAttribute("data-result", "succeeded");
    // The generic columns: who, what it happened to, and how it ended.
    await expect(revokedRow).toContainText("إبطال الجلسات");
    await expect(revokedRow).toContainText("نجحت");
    await expect(revokedRow).toContainText(admin.userId);
    await expect(revokedRow).toContainText(target.userId);
    await expect(revokedRow).toContainText("identity.user");
    await expect(revokedRow).toContainText("جميع الجلسات");

    // Nothing beyond the allowlisted detail reaches the page.
    const rendered = (await page.locator("body").innerHTML()) ?? "";

    expect(rendered).not.toContain(target.email);
    expect(rendered).not.toContain(admin.email);
    expect(rendered).not.toContain("actorSessionId");
    expect(rendered).not.toContain("&quot;scope&quot;");

    const rows = await findAuditRows(target.userId);

    expect(rows).toHaveLength(2);
    expect(rows[0].action).toBe("identity.session.revoked");
    expect(rows[0].actorType).toBe("user");
    expect(rows[0].resourceType).toBe("identity.user");
    expect(rows[0].result).toBe("succeeded");
    expect(rows[0].requestId).not.toBeNull();
    // Stored for investigation, and rendered by nothing.
    expect(rows[0].actorSessionId).not.toBeNull();
    expect(rendered).not.toContain(rows[0].actorSessionId ?? "session");
    expect(JSON.stringify(rows)).not.toContain(target.email);

    // The frozen table receives no new rows.
    expect(await findLegacyAuditRowCount()).toBe(legacyRowsBefore);
  });

  test("lets an administrator work through the area in English", async ({
    page,
    request,
    baseURL,
  }) => {
    const admin = await signUpAdmin(request, baseURL ?? "", "flow-en");

    await signIn(page, "en", admin);
    await page.goto("/en/admin");

    await expect(
      page.getByRole("heading", { level: 1, name: "Administration" }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    await page.getByRole("link", { name: "Users" }).click();
    await expect(page).toHaveURL(/\/en\/admin\/users$/);
    await expect(
      page.getByRole("table", { name: /Users, newest first/ }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Audit trail" }).click();
    await expect(page).toHaveURL(/\/en\/admin\/audit$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Audit trail" }),
    ).toBeVisible();

    // No horizontal overflow at a small viewport.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/en/admin/users");

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );

    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("refuses a self role change and a self revocation", async ({
    page,
    request,
    baseURL,
  }) => {
    const admin = await signUpAdmin(request, baseURL ?? "", "self");

    await signUpAdmin(request, baseURL ?? "", "self-other");
    await signIn(page, "en", admin);

    expect(
      (
        await sendJson(
          page,
          "PATCH",
          `/api/v1/admin/users/${admin.userId}/role`,
          {
            role: "admin",
          },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await sendJson(
          page,
          "PATCH",
          `/api/v1/admin/users/${admin.userId}/role`,
          {
            role: "user",
          },
        )
      ).status,
    ).toBe(403);

    const revoke = await sendJson(
      page,
      "POST",
      `/api/v1/admin/users/${admin.userId}/sessions/revoke`,
    );

    expect(revoke.status).toBe(403);

    // The administrator is still signed in.
    await page.goto("/en/admin");
    await expect(
      page.getByRole("heading", { level: 1, name: "Administration" }),
    ).toBeVisible();

    expect(await findAuditRows(admin.userId)).toHaveLength(0);
  });

  test("refuses an unapproved role value", async ({
    page,
    request,
    baseURL,
  }) => {
    const admin = await signUpAdmin(request, baseURL ?? "", "invalid-role");
    const target = await signUp(request, baseURL ?? "", "invalid-role-target");

    await signIn(page, "en", admin);

    for (const role of ["superadmin", "Admin", "admin,user", "", ["admin"]]) {
      const response = await sendJson(
        page,
        "PATCH",
        `/api/v1/admin/users/${target.userId}/role`,
        { role },
      );

      expect(response.status, JSON.stringify(role)).toBe(400);
      expect(response.body).toEqual({ error: { code: "VALIDATION_FAILED" } });
    }

    expect(
      (await readJson(page, `/api/v1/admin/users/${target.userId}`)).body,
    ).toMatchObject({ data: { roles: ["user"] } });
    expect(await findAuditRows(target.userId)).toHaveLength(0);
  });

  test("refuses removing the admin role from the last administrator", async ({
    page,
    request,
    baseURL,
  }) => {
    const admin = await signUpAdmin(request, baseURL ?? "", "last-admin");

    // Every other administrator this suite created is demoted first. A stray
    // administrator outside the suite would make the conflict unobservable, so the
    // count is asserted rather than assumed.
    expect(await makeSoleAdmin(admin.email)).toBe(0);

    await signIn(page, "en", admin);

    const response = await sendJson(
      page,
      "PATCH",
      `/api/v1/admin/users/${admin.userId}/role`,
      { role: "user" },
    );

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: "CONFLICT" } });

    expect(
      (await readJson(page, `/api/v1/admin/users/${admin.userId}`)).body,
    ).toMatchObject({ data: { roles: ["admin"] } });
    expect(await findAuditRows(admin.userId)).toHaveLength(0);
  });

  test("keeps a direct Better Auth admin call under the same policies", async ({
    page,
    request,
    baseURL,
  }) => {
    const admin = await signUpAdmin(request, baseURL ?? "", "direct");
    const target = await signUp(request, baseURL ?? "", "direct-target");

    expect(await makeSoleAdmin(admin.email)).toBe(0);
    await signIn(page, "en", admin);

    // The self and last-administrator policies apply to the provider endpoint.
    expect(
      (
        await sendJson(page, "POST", "/api/auth/admin/set-role", {
          userId: admin.userId,
          role: "user",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await sendJson(page, "POST", "/api/auth/admin/revoke-user-sessions", {
          userId: admin.userId,
        })
      ).status,
    ).toBe(403);

    // Unsupported operations refuse an administrator as well.
    for (const path of [
      "/api/auth/admin/create-user",
      "/api/auth/admin/remove-user",
      "/api/auth/admin/ban-user",
      "/api/auth/admin/impersonate-user",
      "/api/auth/admin/set-user-password",
      "/api/auth/admin/list-user-sessions",
      "/api/auth/admin/revoke-user-session",
    ]) {
      expect(
        (await sendJson(page, "POST", path, { userId: target.userId })).status,
        path,
      ).toBe(403);
    }

    // A supported direct mutation still records exactly one audit entry.
    expect(
      (
        await sendJson(page, "POST", "/api/auth/admin/revoke-user-sessions", {
          userId: target.userId,
        })
      ).status,
    ).toBe(200);

    const rows = await findAuditRows(target.userId);

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("identity.session.revoked");
    expect(rows[0].actorId).toBe(admin.userId);
    expect(rows[0].requestId).not.toBeNull();
  });

  test("invalidates the target's session after a revocation", async ({
    browser,
    page,
    request,
    baseURL,
  }) => {
    const admin = await signUpAdmin(request, baseURL ?? "", "revoke-admin");
    const target = await signUp(request, baseURL ?? "", "revoke-target");
    const targetContext = await browser.newContext({ baseURL });
    const targetPage = await targetContext.newPage();

    await signIn(targetPage, "en", target);
    await targetPage.goto("/en/account");
    await expect(targetPage.locator('[data-slot="account-email"]')).toHaveText(
      target.email,
    );

    await signIn(page, "en", admin);

    expect(
      (
        await sendJson(
          page,
          "POST",
          `/api/v1/admin/users/${target.userId}/sessions/revoke`,
        )
      ).status,
    ).toBe(200);

    // The same browser session no longer resolves; the server decides, not the
    // client.
    await targetPage.goto("/en/account");
    await expect(targetPage).toHaveURL(
      /\/en\/login\?returnTo=%2Fen%2Faccount$/,
    );

    await targetContext.close();
  });

  test("pages the audit trail by cursor in the browser", async ({
    page,
    request,
    baseURL,
  }) => {
    const admin = await signUpAdmin(request, baseURL ?? "", "audit-page");
    const first = await signUp(request, baseURL ?? "", "audit-page-first");
    const second = await signUp(request, baseURL ?? "", "audit-page-second");

    await signIn(page, "en", admin);

    // Two records, so there is more than one page at a limit of one.
    for (const target of [first, second]) {
      expect(
        (
          await sendJson(
            page,
            "POST",
            `/api/v1/admin/users/${target.userId}/sessions/revoke`,
          )
        ).status,
      ).toBe(200);
    }

    // The API is the bounded surface, and it refuses an offset outright.
    const firstApiPage = await readJson(page, "/api/v1/admin/audit?limit=1");
    const firstBody = firstApiPage.body as {
      data: { records: Array<{ id: string }>; nextCursor: string | null };
    };

    expect(firstApiPage.status).toBe(200);
    expect(firstBody.data.records).toHaveLength(1);
    expect(firstBody.data.nextCursor).not.toBeNull();
    expect((await readJson(page, "/api/v1/admin/audit?offset=1")).status).toBe(
      400,
    );

    const secondApiPage = await readJson(
      page,
      `/api/v1/admin/audit?limit=1&cursor=${encodeURIComponent(
        firstBody.data.nextCursor as string,
      )}`,
    );
    const secondBody = secondApiPage.body as {
      data: { records: Array<{ id: string }> };
    };

    expect(secondApiPage.status).toBe(200);
    expect(secondBody.data.records[0]?.id).not.toBe(
      firstBody.data.records[0]?.id,
    );

    // And the page offers the same movement as a locale-aware link.
    await page.goto("/en/admin/audit");

    const rowsOnFirstPage = await page
      .locator('[data-slot="admin-audit-row"]')
      .count();

    expect(rowsOnFirstPage).toBeGreaterThan(0);

    const nextPage = page.locator('[data-slot="admin-audit-next-page"]');

    if ((await nextPage.count()) > 0) {
      const firstRowResource = await page
        .locator('[data-slot="admin-audit-row"]')
        .first()
        .innerText();

      await nextPage.click();
      await expect(page).toHaveURL(/\/en\/admin\/audit\?cursor=/);
      await expect(
        page.locator('[data-slot="admin-audit-row"]').first(),
      ).not.toHaveText(firstRowResource);
    }

    // A malformed cursor is a bad URL, not a server error. The page is
    // partially prerendered, so its shell is already flushed by the time the
    // cursor is read and the status stays 200; what the visitor gets is the
    // not-found body rather than a trail paged from the beginning.
    await page.goto("/en/admin/audit?cursor=not-a-cursor");

    await expect(page.locator('[data-slot="admin-audit-list"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="admin-audit-row"]')).toHaveCount(0);
  });

  test("answers the versioned API contract over the wire", async ({
    page,
    request,
    baseURL,
  }) => {
    const admin = await signUpAdmin(request, baseURL ?? "", "contract-admin");

    await signIn(page, "en", admin);

    const propagated = "8b1d2c3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";

    // Success, refusal, and a missing record are one envelope, one status
    // mapping, and one correlation header. There is no empty body anywhere.
    const answers = await page.evaluate(
      async ([requestId, missingUserId]) => {
        const paths = [
          "/api/v1/admin/users",
          "/api/v1/admin/users?limit=9999",
          `/api/v1/admin/users/${missingUserId}`,
          "/api/v1/admin/audit",
        ];

        return Promise.all(
          paths.map(async (path) => {
            const response = await fetch(path, {
              headers: { "x-request-id": requestId as string },
            });

            return {
              path,
              status: response.status,
              requestId: response.headers.get("x-request-id"),
              contentType: response.headers.get("content-type"),
              text: await response.text(),
            };
          }),
        );
      },
      [propagated, MISSING_USER_ID] as const,
    );

    expect(answers.map((answer) => answer.status)).toEqual([
      200, 400, 404, 200,
    ]);

    for (const answer of answers) {
      expect(answer.requestId, answer.path).toBe(propagated);
      expect(answer.contentType, answer.path).toContain("application/json");

      const body = JSON.parse(answer.text) as Record<string, unknown>;

      expect(Object.keys(body), answer.path).toEqual([
        answer.status < 400 ? "data" : "error",
      ]);
      expect(answer.text, answer.path).not.toContain("message");
      expect(answer.text, answer.path).not.toContain("stack");
    }

    // A revocation carries no payload and still answers a JSON envelope.
    const target = await signUp(request, baseURL ?? "", "contract-target");
    const revoke = await sendJson(
      page,
      "POST",
      `/api/v1/admin/users/${target.userId}/sessions/revoke`,
    );

    expect(revoke.status).toBe(200);
    expect(revoke.body).toEqual({ data: null });

    // The unversioned path the endpoints moved from is gone. It answers the
    // framework's own not-found page, not an envelope, because no route exists.
    expect((await page.goto("/api/admin/users"))?.status()).toBe(404);
  });

  test("keeps the earlier authentication behavior intact", async ({
    page,
    request,
    baseURL,
  }) => {
    const user = await signUp(request, baseURL ?? "", "regression");

    // The protected account page still redirects and still signs in.
    await page.goto("/en/account");
    await expect(page).toHaveURL(/\/en\/login\?returnTo=%2Fen%2Faccount$/);

    await signIn(page, "en", user);
    await expect(page.locator('[data-slot="account-email"]')).toHaveText(
      user.email,
    );

    // No authorization decision is stored in the browser.
    const storage = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
    }));

    expect(storage.local).toBe("{}");
    expect(storage.session).toBe("{}");

    // Security headers and the request id survive on an administration route.
    const response = await page.goto("/en/admin");

    expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response?.headers()["x-frame-options"]).toBe("DENY");
    expect(response?.headers()["referrer-policy"]).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response?.headers()["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    // Locale behavior is unchanged.
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/ar\/admin/);

    // Signing out still works.
    await page.goto("/en/account");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/en\/login$/);
  });
});
