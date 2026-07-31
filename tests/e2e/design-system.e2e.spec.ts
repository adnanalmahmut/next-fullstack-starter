import { expect, test } from "@playwright/test";

const locales = [
  {
    locale: "ar",
    direction: "rtl",
    heading: "أساس نظام التصميم",
  },
  {
    locale: "en",
    direction: "ltr",
    heading: "Design system foundation",
  },
] as const;

for (const { locale, direction, heading } of locales) {
  test(`${locale} showcase exposes the localized component reference`, async ({
    page,
  }) => {
    const response = await page.goto(`/${locale}/design-system`);

    expect(response?.ok()).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("dir", direction);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(7);
    await expect(page.locator('[data-slot="status-state"]')).toHaveCount(3);
  });
}

test("keyboard workflows preserve overlay focus and support transient controls", async ({
  page,
}) => {
  await page.goto("/en/design-system");

  const dialogTrigger = page.getByRole("button", { name: "Open dialog" });
  await dialogTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Review details" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(dialogTrigger).toBeFocused();

  const menuTrigger = page.getByRole("button", { name: "Open menu" });
  await menuTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "View details" }),
  ).toBeVisible();
  for (const itemName of ["View details", "Duplicate", "Remove"]) {
    await expect(
      page
        .getByRole("menuitem", { name: itemName })
        .locator("xpath=ancestor::*[@role='group'][1]"),
    ).toHaveCount(1);
  }
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(menuTrigger).toBeFocused();

  const select = page.getByRole("combobox", { name: "Workspace" });
  await select.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Product" })).toBeVisible();
  await page.getByRole("option", { name: "Operations" }).press("Enter");
  await expect(select).toContainText("Operations");

  await page.getByRole("button", { name: "Show toast" }).click();
  await expect(page.getByText("Caller-provided notification")).toBeVisible();
});

test("toast remains above an open dialog", async ({ page }) => {
  await page.goto("/en/design-system");

  await page.getByRole("button", { name: "Open dialog" }).click();
  const dialog = page.getByRole("dialog", { name: "Review details" });
  await expect(dialog).toBeVisible();

  await page
    .locator("button")
    .filter({ hasText: "Show toast" })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page.getByText("Caller-provided notification")).toBeVisible();

  const layers = await page.evaluate(() => {
    const backdrop = document.querySelector<HTMLElement>(
      '[data-slot="dialog-overlay"]',
    );
    const content = document.querySelector<HTMLElement>(
      '[data-slot="dialog-content"]',
    );
    const toaster = document.querySelector<HTMLElement>(
      "[data-sonner-toaster]",
    );

    return {
      backdrop: Number.parseInt(getComputedStyle(backdrop!).zIndex, 10),
      overlay: Number.parseInt(getComputedStyle(content!).zIndex, 10),
      toast: Number.parseInt(getComputedStyle(toaster!).zIndex, 10),
    };
  });

  expect(layers.backdrop).toBeLessThan(layers.overlay);
  expect(layers.overlay).toBeLessThan(layers.toast);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Open dialog" })).toBeFocused();
});

test("destructive confirmation is titled, cancellable, and focus-controlled", async ({
  page,
}) => {
  await page.goto("/en/design-system");

  const trigger = page.getByRole("button", {
    name: "Destructive confirmation",
  });
  await trigger.focus();
  await page.keyboard.press("Enter");

  const alertDialog = page.getByRole("alertdialog", {
    name: "Remove this example?",
  });
  await expect(alertDialog).toContainText(
    "This demonstrates a destructive confirmation without business logic.",
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(alertDialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("focus treatment is visible", async ({ page }) => {
  await page.goto("/en/design-system");

  const control = page.getByRole("button", { name: "Primary", exact: true });
  await control.focus();

  const focusStyle = await control.evaluate((element) => {
    const style = getComputedStyle(element);

    return {
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });

  const hasOutline =
    focusStyle.outlineStyle !== "none" &&
    Number.parseFloat(focusStyle.outlineWidth) > 0;

  expect(hasOutline || focusStyle.boxShadow !== "none").toBe(true);
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  for (const { locale } of locales) {
    test(`${locale} showcase has no horizontal overflow on ${viewport.name}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/${locale}/design-system`);

      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));

      expect(dimensions.scrollWidth).toBeLessThanOrEqual(
        dimensions.clientWidth,
      );
    });
  }
}
