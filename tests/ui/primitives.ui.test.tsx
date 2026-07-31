import { BellIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Button } from "@/ui/primitives/button";
import { Checkbox } from "@/ui/primitives/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/ui/primitives/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/primitives/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/ui/primitives/field";
import { Input } from "@/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";
import { Spinner } from "@/ui/primitives/spinner";
import { Textarea } from "@/ui/primitives/textarea";

describe("Button", () => {
  it("renders variants, sizes, and an accessible icon control", () => {
    const { container } = render(
      <>
        <Button>Save</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="link">Link</Button>
        <Button size="sm">Small</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" aria-label="Notifications">
          <BellIcon />
        </Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "Save" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Notifications" })).toBeVisible();
    expect(
      container.querySelector('[data-variant="destructive"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-size="sm"]')).not.toBeNull();
    expect(container.querySelector('[data-size="lg"]')).not.toBeNull();
  });

  it("supports click and keyboard activation without duplicate disabled actions", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Continue</Button>);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    screen.getByRole("button", { name: "Continue" }).focus();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(2);

    rerender(
      <Button disabled onClick={onClick}>
        Continue
      </Button>,
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("composes pending content from Button and Spinner", () => {
    render(
      <Button disabled>
        <Spinner data-icon="inline-start" />
        Saving
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Saving" })).toBeDisabled();
    expect(document.querySelector('[data-slot="spinner"]')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});

describe("Field controls", () => {
  it("associates labels, descriptions, errors, and invalid state", () => {
    render(
      <>
        <Field data-invalid="true">
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            aria-invalid="true"
            aria-describedby="email-description email-error"
          />
          <FieldDescription id="email-description">
            Work address
          </FieldDescription>
          <FieldError id="email-error">Invalid address</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="message">Message</FieldLabel>
          <Textarea id="message" disabled />
        </Field>
      </>,
    );

    expect(screen.getByRole("textbox", { name: "Email" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByText("Work address")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid address");
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
  });

  it("toggles Checkbox from the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <Field orientation="horizontal">
        <Checkbox id="updates" />
        <FieldLabel htmlFor="updates">Updates</FieldLabel>
      </Field>,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Updates" });
    checkbox.focus();
    await user.keyboard(" ");
    expect(checkbox).toBeChecked();
  });

  it.each(["ltr", "rtl"] as const)(
    "opens Select from the keyboard and chooses an item in %s",
    async (direction) => {
      document.documentElement.dir = direction;
      const user = userEvent.setup();
      render(
        <Field>
          <FieldLabel htmlFor={`workspace-${direction}`}>Workspace</FieldLabel>
          <Select dir={direction}>
            <SelectTrigger id={`workspace-${direction}`}>
              <SelectValue placeholder="Choose" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="product">Product</SelectItem>
                <SelectItem value="operations">Operations</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>,
      );

      const trigger = screen.getByRole("combobox", { name: "Workspace" });
      trigger.focus();
      await user.keyboard("{ArrowDown}");
      expect(screen.getByRole("option", { name: "Product" })).toBeVisible();
      await user.keyboard("{ArrowDown}{Enter}");
      expect(trigger).toHaveTextContent("Operations");
    },
  );
});

describe("Overlay primitives", () => {
  it("manages Dialog focus, Escape dismissal, and focus restoration", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open details</Button>
        </DialogTrigger>
        <DialogContent closeLabel="Close details">
          <DialogTitle>Details</DialogTitle>
          <DialogDescription>Dialog description</DialogDescription>
          <Button>Inside action</Button>
        </DialogContent>
      </Dialog>,
    );

    const trigger = screen.getByRole("button", { name: "Open details" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Details" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close details" })).toBeVisible();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
      true,
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it.each(["ltr", "rtl"] as const)(
    "opens and activates DropdownMenu by keyboard in %s",
    async (direction) => {
      document.documentElement.dir = direction;
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(
        <DropdownMenu dir={direction}>
          <DropdownMenuTrigger asChild>
            <Button>Actions</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={onSelect}>Inspect</DropdownMenuItem>
              <DropdownMenuItem>Duplicate</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>,
      );

      const trigger = screen.getByRole("button", { name: "Actions" });
      trigger.focus();
      await user.keyboard("{ArrowDown}");
      expect(screen.getByRole("menuitem", { name: "Inspect" })).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(onSelect).toHaveBeenCalledOnce();
      expect(trigger).toHaveFocus();
    },
  );
});
