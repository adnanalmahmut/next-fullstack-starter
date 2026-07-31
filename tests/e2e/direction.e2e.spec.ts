import { expect, test, type Page } from "@playwright/test";

/**
 * Direction is verified geometrically, not by reading `dir` from `<html>`.
 * Radix stamps its own `dir` on triggers and portalled content, so only real
 * bounding boxes and computed styles prove that RTL reaches the overlay.
 */

// Logical edges are compared with a tolerance that absorbs borders, subpixel
// layout, and font metrics, so no assertion depends on a fixed pixel position.
const EDGE_TOLERANCE = 6;
const INNER_PADDING_TOLERANCE = 24;

const locales = [
  { locale: "ar", direction: "rtl" },
  { locale: "en", direction: "ltr" },
] as const;

async function waitForSettledAnimations(page: Page, selector: string) {
  await page.waitForFunction(
    (target) =>
      Array.from(document.querySelectorAll(target)).every((element) =>
        element
          .getAnimations()
          .every((animation) => animation.playState === "finished"),
      ),
    selector,
  );
}

async function readSelectGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element) => {
      const { left, right, width } = element.getBoundingClientRect();

      return { left, right, width };
    };
    const inkBox = (element: Element) => {
      const range = document.createRange();
      range.selectNodeContents(element);

      const { left, right, width } = range.getBoundingClientRect();

      return { left, right, width };
    };
    const trigger = document.querySelector("#showcase-select")!;
    const content = document.querySelector<HTMLElement>(
      '[data-slot="select-content"]',
    )!;
    const selectedItem = content.querySelector<HTMLElement>(
      '[data-slot="select-item"][data-state="checked"]',
    )!;
    const disabledItem = content.querySelector<HTMLElement>(
      '[data-slot="select-item"][data-disabled]',
    )!;
    const indicator = selectedItem.querySelector(
      '[data-slot="select-item-indicator"]',
    )!;
    // The item renders the indicator span first and the item text last; the
    // indicator wraps its own span, so only the direct last child is the text.
    const itemText = (item: Element) =>
      inkBox(item.querySelector(":scope > span:last-child")!);

    return {
      triggerDir: trigger.getAttribute("dir"),
      contentDir: content.getAttribute("dir"),
      itemTextAlign: getComputedStyle(selectedItem).textAlign,
      itemDirection: getComputedStyle(selectedItem).direction,
      trigger: box(trigger),
      content: box(content),
      indicator: box(indicator),
      selectedText: itemText(selectedItem),
      disabledText: itemText(disabledItem),
    };
  });
}

async function readClosedSelectGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element) => {
      const { left, right } = element.getBoundingClientRect();

      return { left, right };
    };
    const trigger = document.querySelector("#showcase-select")!;

    return {
      dir: trigger.getAttribute("dir"),
      direction: getComputedStyle(trigger).direction,
      trigger: box(trigger),
      value: box(trigger.querySelector('[data-slot="select-value"]')!),
      chevron: box(trigger.querySelector("svg")!),
    };
  });
}

async function readMenuGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element) => {
      const { left, right, width } = element.getBoundingClientRect();

      return { left, right, width };
    };
    const inkBox = (element: Element) => {
      const range = document.createRange();
      range.selectNodeContents(element);

      const { left, right, width } = range.getBoundingClientRect();

      return { left, right, width };
    };
    const content = document.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-content"]',
    )!;
    const label = content.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-label"]',
    )!;
    const firstItem = content.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-item"]:not([data-variant="destructive"])',
    )!;
    const destructiveItem = content.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-item"][data-variant="destructive"]',
    )!;
    const subTrigger = content.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-sub-trigger"]',
    )!;
    const chevron =
      subTrigger.querySelector<HTMLElement>("[data-directional]")!;

    return {
      contentDir: content.getAttribute("dir"),
      itemTextAlign: getComputedStyle(firstItem).textAlign,
      itemDirection: getComputedStyle(firstItem).direction,
      chevronTransform: getComputedStyle(chevron).transform,
      // Non-directional glyphs must never be mirrored.
      triggerIconTransform: getComputedStyle(
        document.querySelector<HTMLElement>(
          '[data-slot="dropdown-menu-trigger"] svg',
        )!,
      ).transform,
      directionalMarkers: content.querySelectorAll("[data-directional]").length,
      content: box(content),
      labelText: inkBox(label),
      firstItemText: inkBox(firstItem),
      destructiveText: inkBox(destructiveItem),
      chevron: box(chevron),
    };
  });
}

async function readMenuTriggerGeometry(page: Page) {
  return page.evaluate(() => {
    const trigger = document.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-trigger"]',
    )!;
    const textNode = Array.from(trigger.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
    )!;
    const range = document.createRange();
    range.selectNode(textNode);

    const triggerRect = trigger.getBoundingClientRect();
    const textRect = range.getBoundingClientRect();
    const iconRect = trigger.querySelector("svg")!.getBoundingClientRect();

    return {
      trigger: { left: triggerRect.left, right: triggerRect.right },
      text: { left: textRect.left, right: textRect.right },
      icon: { left: iconRect.left, right: iconRect.right },
    };
  });
}

for (const { locale, direction } of locales) {
  const isRtl = direction === "rtl";

  test(`${locale} Select places value, chevron, item text, and indicator on the correct logical sides`, async ({
    page,
  }) => {
    await page.goto(`/${locale}/design-system`);

    const trigger = page.locator("#showcase-select");
    await trigger.scrollIntoViewIfNeeded();

    const closed = await readClosedSelectGeometry(page);

    expect(closed.dir).toBe(direction);
    expect(closed.direction).toBe(direction);

    if (isRtl) {
      // Value on the inline-start (right); chevron on the inline-end (left).
      expect(closed.value.left).toBeGreaterThan(closed.chevron.right);
      expect(closed.chevron.left - closed.trigger.left).toBeLessThan(
        INNER_PADDING_TOLERANCE,
      );
      expect(closed.trigger.right - closed.value.right).toBeLessThan(
        INNER_PADDING_TOLERANCE,
      );
    } else {
      expect(closed.value.right).toBeLessThan(closed.chevron.left);
      expect(closed.trigger.right - closed.chevron.right).toBeLessThan(
        INNER_PADDING_TOLERANCE,
      );
      expect(closed.value.left - closed.trigger.left).toBeLessThan(
        INNER_PADDING_TOLERANCE,
      );
    }

    // Select a value first so the checked indicator is rendered on reopen.
    await trigger.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByRole("option").first().click();
    await expect(page.getByRole("listbox")).toBeHidden();

    await trigger.click();
    await expect(page.getByRole("listbox")).toBeVisible();

    const open = await readSelectGeometry(page);

    expect(open.contentDir).toBe(direction);
    expect(open.triggerDir).toBe(direction);
    expect(open.itemTextAlign).toBe("start");
    expect(open.itemDirection).toBe(direction);

    if (isRtl) {
      // Item text on the right, check indicator on the left.
      expect(open.selectedText.left).toBeGreaterThan(open.indicator.right);
      expect(open.indicator.left - open.content.left).toBeLessThan(
        INNER_PADDING_TOLERANCE,
      );
      // Content's logical start edge (right) tracks the trigger's right edge.
      expect(Math.abs(open.content.right - open.trigger.right)).toBeLessThan(
        EDGE_TOLERANCE,
      );
      // The disabled item follows the same direction as the enabled items.
      expect(
        Math.abs(open.disabledText.right - open.selectedText.right),
      ).toBeLessThan(EDGE_TOLERANCE);
    } else {
      expect(open.selectedText.right).toBeLessThan(open.indicator.left);
      expect(open.content.right - open.indicator.right).toBeLessThan(
        INNER_PADDING_TOLERANCE,
      );
      expect(Math.abs(open.content.left - open.trigger.left)).toBeLessThan(
        EDGE_TOLERANCE,
      );
      expect(
        Math.abs(open.disabledText.left - open.selectedText.left),
      ).toBeLessThan(EDGE_TOLERANCE);
    }

    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(trigger).toBeFocused();

    // Keyboard selection stays functional in both directions.
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("listbox")).toBeVisible();

    const options = page.getByRole("option");
    const lastEnabled = options.nth(1);
    const expected = (await lastEnabled.textContent())?.trim() ?? "";

    await lastEnabled.click();
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(trigger).toContainText(expected);
    await expect(trigger).toBeFocused();
  });

  test(`${locale} DropdownMenu mirrors the trigger, content edge, items, and submenu chevron`, async ({
    page,
  }) => {
    await page.goto(`/${locale}/design-system`);

    const trigger = page.locator('[data-slot="dropdown-menu-trigger"]');
    await trigger.scrollIntoViewIfNeeded();

    const closed = await readMenuTriggerGeometry(page);

    if (isRtl) {
      // Trigger text on the inline-start (right); ellipsis on the end (left).
      expect(closed.text.left).toBeGreaterThan(closed.icon.right);
      expect(closed.icon.left - closed.trigger.left).toBeLessThan(
        INNER_PADDING_TOLERANCE,
      );
      expect(closed.trigger.right - closed.text.right).toBeLessThan(
        INNER_PADDING_TOLERANCE,
      );
    } else {
      expect(closed.text.right).toBeLessThan(closed.icon.left);
      expect(closed.trigger.right - closed.icon.right).toBeLessThan(
        INNER_PADDING_TOLERANCE,
      );
      expect(closed.text.left - closed.trigger.left).toBeLessThan(
        INNER_PADDING_TOLERANCE,
      );
    }

    await trigger.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await waitForSettledAnimations(page, '[data-slot="dropdown-menu-content"]');

    const open = await readMenuGeometry(page);
    const triggerBox = (await trigger.boundingBox())!;

    expect(open.contentDir).toBe(direction);
    expect(open.itemTextAlign).toBe("start");
    expect(open.itemDirection).toBe(direction);
    // Only the submenu chevron carries the directional marker.
    expect(open.directionalMarkers).toBe(1);
    // The ellipsis is a non-directional glyph and must stay unmirrored.
    expect(open.triggerIconTransform === "none").toBe(true);

    if (isRtl) {
      expect(open.chevronTransform).toBe("matrix(-1, 0, 0, 1, 0, 0)");
      // Content's right edge aligns with the trigger's right edge.
      expect(
        Math.abs(open.content.right - (triggerBox.x + triggerBox.width)),
      ).toBeLessThan(EDGE_TOLERANCE);
      // Label, items, and the destructive item all start at the right.
      for (const ink of [
        open.labelText,
        open.firstItemText,
        open.destructiveText,
      ]) {
        expect(open.content.right - ink.right).toBeLessThan(
          INNER_PADDING_TOLERANCE,
        );
        expect(ink.right).toBeGreaterThan(open.content.left + ink.width);
      }
      // The submenu chevron sits at the logical end (left).
      expect(open.chevron.left - open.content.left).toBeLessThan(
        INNER_PADDING_TOLERANCE,
      );
    } else {
      expect(open.chevronTransform === "none").toBe(true);
      expect(Math.abs(open.content.left - triggerBox.x)).toBeLessThan(
        EDGE_TOLERANCE,
      );
      for (const ink of [
        open.labelText,
        open.firstItemText,
        open.destructiveText,
      ]) {
        expect(ink.left - open.content.left).toBeLessThan(
          INNER_PADDING_TOLERANCE,
        );
        expect(ink.left).toBeLessThan(open.content.right - ink.width);
      }
      expect(open.content.right - open.chevron.right).toBeLessThan(
        INNER_PADDING_TOLERANCE,
      );
    }

    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(trigger).toBeFocused();

    // Keyboard navigation and focus restoration hold in both directions.
    // Opening with Enter already focuses the first item.
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();

    const items = page.getByRole("menuitem");
    await expect(items.first()).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();

    await page.keyboard.press("ArrowUp");
    await expect(items.first()).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}
