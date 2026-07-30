import type { BrowserContext } from "@playwright/test";
import { expect, test } from "@playwright/test";

const requestIdHeader = "x-request-id";
const validRequestId = "123e4567-e89b-42d3-a456-426614174000";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function expectLocaleCookie(
  context: BrowserContext,
  expectedLocale: string,
) {
  const cookies = await context.cookies();
  const localeCookie = cookies.find((cookie) => cookie.name === "APP_LOCALE");

  expect(localeCookie?.value).toBe(expectedLocale);
}

test.describe("localized home page", () => {
  test("redirects an unprefixed request to the default locale", async ({
    page,
    context,
  }) => {
    const response = await page.goto("/");

    expect(response?.ok()).toBe(true);
    expect(response?.headers()[requestIdHeader]).toMatch(requestIdPattern);
    await expect(page).toHaveURL(/\/ar$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "قالب Next.js متكامل",
    );

    await expectLocaleCookie(context, "ar");
  });

  test("uses an explicit secondary locale and synchronizes the cookie", async ({
    page,
    context,
  }) => {
    await page.goto("/ar");
    await expectLocaleCookie(context, "ar");

    const response = await page.goto("/en");

    expect(response?.ok()).toBe(true);
    await expect(page).toHaveURL(/\/en$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Next.js Full-stack Starter",
    );

    await expectLocaleCookie(context, "en");
  });

  test("retains a valid incoming request ID", async ({ page }) => {
    await page.setExtraHTTPHeaders({
      [requestIdHeader]: validRequestId,
    });

    const response = await page.goto("/");

    expect(response?.ok()).toBe(true);
    expect(response?.headers()[requestIdHeader]).toBe(validRequestId);
    await expect(page).toHaveURL(/\/ar$/);
  });

  test("replaces an invalid incoming request ID", async ({ page }) => {
    const invalidRequestId = "not-a-valid-request-id";

    await page.setExtraHTTPHeaders({
      [requestIdHeader]: invalidRequestId,
    });

    const response = await page.goto("/ar");
    const responseRequestId = response?.headers()[requestIdHeader];

    expect(response?.ok()).toBe(true);
    expect(responseRequestId).not.toBe(invalidRequestId);
    expect(responseRequestId).toMatch(requestIdPattern);
  });

  test("switches locale and preserves search parameters", async ({
    page,
    context,
  }) => {
    await page.goto("/ar?source=e2e");

    await page.getByRole("combobox", { name: "اللغة" }).selectOption("en");

    await expect(page).toHaveURL(/\/en\?source=e2e$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    await expectLocaleCookie(context, "en");
  });
});
