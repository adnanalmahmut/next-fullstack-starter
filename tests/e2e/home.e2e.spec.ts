import type { BrowserContext } from "@playwright/test";
import { expect, test } from "@playwright/test";

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
