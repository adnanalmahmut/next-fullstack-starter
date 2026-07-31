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
    const externalRequests: string[] = [];

    page.on("request", (request) => {
      const url = new URL(request.url());

      if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
        externalRequests.push(request.url());
      }
    });

    const response = await page.goto(`/${locale}/design-system`);

    expect(response?.ok()).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("dir", direction);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(7);
    await expect(page.locator('[data-slot="status-state"]')).toHaveCount(3);

    const typography = await page.evaluate(async () => {
      await document.fonts.ready;

      const styleFor = (selector: string) => {
        const style = getComputedStyle(document.querySelector(selector)!);

        return {
          family: style.fontFamily,
          weight: style.fontWeight,
          fontSize: Number.parseFloat(style.fontSize),
          lineHeight: Number.parseFloat(style.lineHeight),
        };
      };
      const rootStyle = getComputedStyle(document.documentElement);
      const sansVariable = rootStyle
        .getPropertyValue("--font-thmanyah-sans")
        .trim();
      const serifVariable = rootStyle
        .getPropertyValue("--font-thmanyah-serif-display")
        .trim();
      const monoVariable = rootStyle
        .getPropertyValue("--font-geist-mono")
        .trim();
      // Only the first family in each variable is the self-hosted face. The
      // metric-adjusted `… Fallback` entries resolve through `local()`, so a
      // check against the whole list depends on host-installed fonts.
      const selfHosted = (familyList: string) =>
        familyList.split(",")[0].trim();

      return {
        status: document.fonts.status,
        sansVariable,
        serifVariable,
        monoVariable,
        loadedFaces: [...document.fonts]
          .filter(
            (face) =>
              face.status === "loaded" && !face.family.endsWith("Fallback"),
          )
          .map((face) => `${face.family} ${face.weight}`),
        available: {
          sansRegular: document.fonts.check(
            `400 16px ${selfHosted(sansVariable)}`,
          ),
          sansMedium: document.fonts.check(
            `500 16px ${selfHosted(sansVariable)}`,
          ),
          sansBold: document.fonts.check(
            `700 16px ${selfHosted(sansVariable)}`,
          ),
          serifBold: document.fonts.check(
            `700 16px ${selfHosted(serifVariable)}`,
          ),
          serifBlack: document.fonts.check(
            `900 16px ${selfHosted(serifVariable)}`,
          ),
          mono: document.fonts.check(`400 16px ${selfHosted(monoVariable)}`),
        },
        body: styleFor('[data-typography="body"]'),
        heading: styleFor('[data-typography="heading"]'),
        label: styleFor('[data-typography="label"]'),
        displayBold: styleFor('[data-typography="display-bold"]'),
        displayBlack: styleFor('[data-typography="display-black"]'),
        mono: styleFor('[data-typography="mono"]'),
        // Only an element that actually clips can cut text off. Glyph ink
        // reaching a couple of pixels past a tight line box is normal and
        // stays visible, so `overflow: visible` elements are not clipping.
        clippedElements: [
          ...document.querySelectorAll<HTMLElement>(
            "h1, h2, [data-typography], button, input, textarea",
          ),
        ]
          .filter((element) => {
            const { overflowX, overflowY } = getComputedStyle(element);

            return (
              element.clientWidth > 0 &&
              element.clientHeight > 0 &&
              ((overflowX !== "visible" &&
                element.scrollWidth > element.clientWidth + 1) ||
                (overflowY !== "visible" &&
                  element.scrollHeight > element.clientHeight + 1))
            );
          })
          .map(
            (element) =>
              element.getAttribute("data-typography") ??
              element.getAttribute("data-slot") ??
              element.tagName,
          ),
      };
    });

    const primaryFamily = (familyList: string) =>
      familyList.split(",")[0].replaceAll('"', "").trim();

    expect(typography.status).toBe("loaded");
    // Every self-hosted weight actually loaded, and no unused weight shipped.
    expect(typography.loadedFaces.sort()).toEqual([
      "Geist Mono 100 900",
      "thmanyahSans 400",
      "thmanyahSans 500",
      "thmanyahSans 700",
      "thmanyahSerifDisplay 700",
      "thmanyahSerifDisplay 900",
    ]);
    expect(typography.available).toEqual({
      sansRegular: true,
      sansMedium: true,
      sansBold: true,
      serifBold: true,
      serifBlack: true,
      mono: true,
    });
    expect(typography.body.family).toContain(
      primaryFamily(typography.sansVariable),
    );
    expect(typography.body.family).not.toMatch(/Geist Sans|Noto Sans Arabic/i);
    expect(typography.heading.family).toContain(
      primaryFamily(typography.sansVariable),
    );
    expect(typography.label.family).toContain(
      primaryFamily(typography.sansVariable),
    );
    expect(typography.displayBold.family).toContain(
      primaryFamily(typography.serifVariable),
    );
    expect(typography.displayBlack.family).toContain(
      primaryFamily(typography.serifVariable),
    );
    expect(typography.mono.family).toContain(
      primaryFamily(typography.monoVariable),
    );
    expect(typography.body.weight).toBe("400");
    expect(typography.heading.weight).toBe("700");
    expect(typography.label.weight).toBe("500");
    expect(typography.displayBold.weight).toBe("700");
    expect(typography.displayBlack.weight).toBe("900");
    expect(typography.clippedElements).toEqual([]);

    // Every scale pairs its size with a line height that leaves the text room.
    for (const sample of [
      typography.body,
      typography.heading,
      typography.label,
      typography.displayBold,
      typography.displayBlack,
      typography.mono,
    ]) {
      expect(sample.lineHeight).toBeGreaterThan(sample.fontSize);
    }

    expect(externalRequests).toEqual([]);
  });
}

test("interactive primitives inherit the application family", async ({
  page,
}) => {
  await page.goto("/en/design-system");

  await page.getByRole("button", { name: "Open dialog" }).click();
  const dialog = page.getByRole("dialog", { name: "Review details" });
  await expect(dialog).toBeVisible();

  const dialogFamily = await dialog.evaluate(
    (element) => getComputedStyle(element).fontFamily,
  );
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Open menu" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const menuFamily = await menu.evaluate(
    (element) => getComputedStyle(element).fontFamily,
  );
  await page.keyboard.press("Escape");

  const select = page.getByRole("combobox", { name: "Workspace" });
  await select.click();
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  const listboxFamily = await listbox.evaluate(
    (element) => getComputedStyle(element).fontFamily,
  );
  await page.keyboard.press("Escape");

  const families = await page.evaluate(() => {
    const family = (selector: string) =>
      getComputedStyle(document.querySelector(selector)!).fontFamily;

    return {
      application: getComputedStyle(document.documentElement)
        .getPropertyValue("--font-thmanyah-sans")
        .split(",")[0]
        .replaceAll('"', "")
        .trim(),
      button: family('[data-slot="button"]'),
      input: family('[data-slot="input"]'),
      textarea: family('[data-slot="textarea"]'),
    };
  });

  for (const family of [
    families.button,
    families.input,
    families.textarea,
    dialogFamily,
    menuFamily,
    listboxFamily,
  ]) {
    expect(family).toContain(families.application);
  }
});

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
