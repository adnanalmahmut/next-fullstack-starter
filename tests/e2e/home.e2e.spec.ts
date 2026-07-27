import { expect, test } from "@playwright/test";

test("renders the home page", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.ok()).toBe(true);
  await expect(page.locator("main")).toBeVisible();
});
