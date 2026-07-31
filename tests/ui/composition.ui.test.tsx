import { ArrowRightIcon, CircleIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { DirectionalIcon } from "@/ui/directional-icon";
import { PageContainer } from "@/ui/layout/page-container";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/ui/primitives/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/ui/primitives/alert-dialog";
import { Badge } from "@/ui/primitives/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/ui/primitives/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/primitives/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/primitives/dropdown-menu";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "@/ui/primitives/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";
import { Separator } from "@/ui/primitives/separator";
import { Spinner } from "@/ui/primitives/spinner";

describe("primitive compositions", () => {
  it("renders layout, card, badge, alert, separator, and directional contracts", () => {
    const { container } = render(
      <PageContainer>
        <Card size="sm">
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>Account description</CardDescription>
            <CardAction>
              <Badge asChild>
                <a href="#account">Open</a>
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <Alert variant="info">
              <CircleIcon />
              <AlertTitle>Information</AlertTitle>
              <AlertDescription>Details</AlertDescription>
              <AlertAction>Action</AlertAction>
            </Alert>
            <Separator decorative={false} />
          </CardContent>
          <CardFooter>Footer</CardFooter>
        </Card>
        <DirectionalIcon>
          <ArrowRightIcon />
        </DirectionalIcon>
        <Spinner aria-label="Loading account" />
      </PageContainer>,
    );

    expect(screen.getByText("Account")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open" })).toBeVisible();
    expect(screen.getByRole("separator")).toBeVisible();
    expect(
      screen.getByRole("status", { name: "Loading account" }),
    ).toBeVisible();
    expect(container.querySelector("[data-directional]")).not.toBeNull();
  });

  it("renders the complete Field family and deduplicates errors", () => {
    const { rerender } = render(
      <FieldSet>
        <FieldLegend variant="label">Profile</FieldLegend>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldLabel>Name</FieldLabel>
            <FieldContent>
              <FieldTitle>Public name</FieldTitle>
              <FieldDescription>Description</FieldDescription>
              <FieldError
                errors={[
                  { message: "Required" },
                  { message: "Required" },
                  { message: "Too short" },
                ]}
              />
            </FieldContent>
          </Field>
          <FieldSeparator>Or</FieldSeparator>
        </FieldGroup>
      </FieldSet>,
    );

    expect(screen.getAllByText("Required")).toHaveLength(1);
    expect(screen.getByText("Too short")).toBeVisible();
    expect(screen.getByText("Or")).toBeVisible();

    rerender(<FieldError errors={[{ message: "Single error" }]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Single error");
  });

  it("renders controlled Dialog and AlertDialog compositions", () => {
    const { unmount } = render(
      <Dialog open>
        <DialogContent closeLabel="Close composed dialog">
          <DialogHeader>
            <DialogTitle>Composed dialog</DialogTitle>
            <DialogDescription>Description</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose>Done</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    expect(
      screen.getByRole("dialog", { name: "Composed dialog" }),
    ).toBeVisible();
    unmount();

    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <CircleIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>Composed alert dialog</AlertDialogTitle>
            <AlertDialogDescription>Description</AlertDialogDescription>
          </AlertDialogHeader>
        </AlertDialogContent>
      </AlertDialog>,
    );

    expect(
      screen.getByRole("alertdialog", { name: "Composed alert dialog" }),
    ).toBeVisible();
  });

  it("renders grouped Select and advanced DropdownMenu members", () => {
    const { unmount } = render(
      <Select open value="first">
        <SelectTrigger aria-label="Grouped select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Choices</SelectLabel>
            <SelectItem value="first">First</SelectItem>
            <SelectSeparator />
            <SelectItem value="second">Second</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    );

    expect(screen.getByRole("option", { name: "First" })).toBeVisible();
    unmount();

    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuPortal>
          <span>Portal marker</span>
        </DropdownMenuPortal>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel inset>Preferences</DropdownMenuLabel>
            <DropdownMenuItem inset>
              Item
              <DropdownMenuShortcut>⌘I</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem checked inset>
              Checked
            </DropdownMenuCheckboxItem>
            <DropdownMenuRadioGroup value="one">
              <DropdownMenuRadioItem value="one" inset>
                Radio
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger inset>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuGroup>
                <DropdownMenuItem>Nested</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(screen.getByRole("menuitem", { name: /Item/ })).toBeVisible();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Checked" }),
    ).toBeChecked();
    expect(screen.getByRole("menuitemradio", { name: "Radio" })).toBeChecked();
    expect(screen.getByText("Nested")).toBeVisible();
    expect(screen.getByText("Portal marker")).toBeVisible();
  });
});
