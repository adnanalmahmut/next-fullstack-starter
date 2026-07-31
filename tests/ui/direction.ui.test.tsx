import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Button } from "@/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/primitives/dropdown-menu";
import { Field, FieldLabel } from "@/ui/primitives/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";

const directions = ["ltr", "rtl"] as const;

const physicalDirectionUtility =
  /(?:^|\s)(?:(?:m|p)[lr]-|left-|right-|text-left|text-right)/;

function expectLogicalOnly(elements: (Element | null | undefined)[]) {
  for (const element of elements) {
    expect(element?.getAttribute("class") ?? "").not.toMatch(
      physicalDirectionUtility,
    );
  }
}

function renderSelect(direction: (typeof directions)[number]) {
  document.documentElement.dir = direction;

  return render(
    <Field>
      <FieldLabel htmlFor="workspace">Workspace</FieldLabel>
      <Select dir={direction}>
        <SelectTrigger id="workspace">
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Teams</SelectLabel>
            <SelectItem value="product">Product</SelectItem>
            <SelectItem value="operations">Operations</SelectItem>
            <SelectItem value="archived" disabled>
              Archived
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>,
  );
}

function renderDropdownMenu(direction: (typeof directions)[number]) {
  document.documentElement.dir = direction;
  const onSelect = vi.fn();

  render(
    <DropdownMenu dir={direction}>
      <DropdownMenuTrigger asChild>
        <Button>Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Manage</DropdownMenuLabel>
          <DropdownMenuItem onSelect={onSelect}>
            View details
            <DropdownMenuShortcut>⌘I</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>Duplicate</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked>Pinned</DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value="recent">
            <DropdownMenuRadioItem value="recent">Recent</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuGroup>
                <DropdownMenuItem>Archived projects</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive">Remove</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>,
  );

  return { onSelect };
}

describe.each(directions)("Select direction contract in %s", (direction) => {
  it("propagates direction to the trigger and portalled listbox and keeps keyboard selection working", async () => {
    const user = userEvent.setup();
    renderSelect(direction);

    const trigger = screen.getByRole("combobox", { name: "Workspace" });

    // Radix writes its resolved direction onto the trigger itself.
    expect(trigger).toHaveAttribute("dir", direction);

    trigger.focus();
    await user.keyboard("{ArrowDown}");

    const listbox = screen.getByRole("listbox");
    const firstOption = screen.getByRole("option", { name: "Product" });

    // Portalled content must carry the same direction as the trigger.
    expect(listbox).toHaveAttribute("dir", direction);
    expect(firstOption).toBeVisible();
    expect(
      screen
        .getByRole("option", { name: "Operations" })
        .closest("[role=group]"),
    ).toBe(firstOption.closest("[role=group]"));

    await user.keyboard("{ArrowDown}{Enter}");

    expect(trigger).toHaveTextContent("Operations");
    expect(trigger).toHaveFocus();
  });

  it("aligns item text, indicator, label, and the disabled item logically", async () => {
    const user = userEvent.setup();
    renderSelect(direction);

    const trigger = screen.getByRole("combobox", { name: "Workspace" });
    await user.click(trigger);

    const option = screen.getByRole("option", { name: "Product" });
    const indicator = option.querySelector(
      '[data-slot="select-item-indicator"]',
    );
    const label = screen.getByText("Teams");
    const disabledOption = screen.getByRole("option", { name: "Archived" });

    expect(option.getAttribute("class")).toContain("text-start");
    expect(option.getAttribute("class")).toContain("ps-1.5");
    expect(option.getAttribute("class")).toContain("pe-8");
    // The check indicator is anchored to the logical end, not a physical side.
    expect(indicator?.getAttribute("class")).toContain("end-2");
    expect(label.getAttribute("class")).toContain("text-start");
    expect(disabledOption.getAttribute("class")).toContain("text-start");
    expect(disabledOption).toHaveAttribute("aria-disabled", "true");
    expect(disabledOption).toHaveAttribute("data-disabled");

    expectLogicalOnly([
      option,
      label,
      trigger,
      disabledOption,
      screen.getByRole("listbox"),
      indicator,
    ]);
  });
});

describe.each(directions)(
  "DropdownMenu direction contract in %s",
  (direction) => {
    it("propagates direction, navigates by keyboard, activates, and restores focus", async () => {
      const user = userEvent.setup();
      const { onSelect } = renderDropdownMenu(direction);

      const trigger = screen.getByRole("button", { name: "Actions" });
      trigger.focus();
      await user.keyboard("{ArrowDown}");

      // Portalled menu content carries the resolved direction.
      expect(screen.getByRole("menu")).toHaveAttribute("dir", direction);
      expect(
        screen.getByRole("menuitem", { name: /View details/ }),
      ).toHaveFocus();

      await user.keyboard("{ArrowDown}");

      expect(screen.getByRole("menuitem", { name: "Duplicate" })).toHaveFocus();

      await user.keyboard("{ArrowUp}{Enter}");

      expect(onSelect).toHaveBeenCalledOnce();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    it("closes on Escape, returns focus, groups every item, and mirrors only the submenu chevron", async () => {
      const user = userEvent.setup();
      renderDropdownMenu(direction);

      const trigger = screen.getByRole("button", { name: "Actions" });
      await user.click(trigger);

      const menu = screen.getByRole("menu");
      const subTrigger = screen.getByRole("menuitem", { name: "Move to" });
      const checkboxItem = screen.getByRole("menuitemcheckbox", {
        name: "Pinned",
      });
      const destructive = screen.getByRole("menuitem", { name: "Remove" });

      for (const item of [
        ...screen.getAllByRole("menuitem"),
        ...screen.getAllByRole("menuitemcheckbox"),
        ...screen.getAllByRole("menuitemradio"),
      ]) {
        expect(item.closest("[role=group]")).not.toBeNull();
      }

      // The destructive item keeps its own group behind the separator.
      expect(destructive).toHaveAttribute("data-variant", "destructive");
      expect(destructive.closest("[role=group]")).not.toBe(
        subTrigger.closest("[role=group]"),
      );

      // Only the submenu chevron is directional; the check icon is not.
      expect(subTrigger.querySelector("[data-directional]")).not.toBeNull();
      expect(menu.querySelectorAll("[data-directional]")).toHaveLength(1);
      expect(checkboxItem.querySelector("[data-directional]")).toBeNull();
      expect(
        checkboxItem
          .querySelector('[data-slot="dropdown-menu-checkbox-item-indicator"]')
          ?.getAttribute("class"),
      ).toContain("end-2");
      expect(screen.getByText("⌘I").getAttribute("class")).toContain("ms-auto");

      for (const element of [
        subTrigger,
        checkboxItem,
        destructive,
        screen.getByText("Manage"),
      ]) {
        expect(element.getAttribute("class")).toContain("text-start");
      }

      expectLogicalOnly([menu, subTrigger, checkboxItem, destructive]);

      await user.keyboard("{Escape}");

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  },
);
