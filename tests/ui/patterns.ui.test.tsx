import { CircleIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DestructiveConfirmation } from "@/ui/patterns/destructive-confirmation";
import { EmptyState } from "@/ui/patterns/empty-state";
import { LoadingState } from "@/ui/patterns/loading-state";
import { StatusState } from "@/ui/patterns/status-state";
import { Button } from "@/ui/primitives/button";

describe("state patterns", () => {
  it("announces compact and content loading states", () => {
    render(
      <>
        <LoadingState label="Loading results" />
        <LoadingState label="Loading profile" variant="content" />
      </>,
    );

    expect(screen.getByText("Loading results")).toBeVisible();
    expect(screen.getByText("Loading profile")).toHaveClass("sr-only");
    expect(screen.getAllByRole("status")).toHaveLength(2);
  });

  it("composes an empty state with optional actions", () => {
    render(
      <EmptyState
        icon={<CircleIcon />}
        title="No records"
        description="Create the first record."
        primaryAction={<Button>Create</Button>}
        secondaryAction={<Button variant="outline">Return</Button>}
      />,
    );

    expect(screen.getByText("No records")).toBeVisible();
    expect(screen.getByText("Create the first record.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Return" })).toBeVisible();
  });

  it.each([
    ["error", "Failed"],
    ["forbidden", "Restricted"],
    ["not-found", "Missing"],
  ] as const)("renders the %s state with icon and text", (status, title) => {
    const { container } = render(
      <StatusState status={status} title={title} description="Explanation" />,
    );

    expect(screen.getByRole("alert")).toHaveAttribute("data-status", status);
    expect(screen.getByText(title)).toBeVisible();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("DestructiveConfirmation", () => {
  it("confirms once and supports cancellation", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <DestructiveConfirmation
        title="Remove record?"
        description="This cannot be undone."
        confirmLabel="Remove"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        trigger={<Button>Open confirmation</Button>}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open confirmation" }));
    expect(
      screen.getByRole("alertdialog", { name: "Remove record?" }),
    ).toHaveTextContent("This cannot be undone.");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalledOnce();

    rerender(
      <DestructiveConfirmation
        title="Remove record?"
        description="This cannot be undone."
        confirmLabel="Remove"
        cancelLabel="Cancel"
        pending
        onConfirm={onConfirm}
        trigger={<Button>Open confirmation</Button>}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open confirmation" }),
    ).toHaveFocus();
  });

  it("closes from cancel and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(
      <DestructiveConfirmation
        title="Remove record?"
        description="This cannot be undone."
        confirmLabel="Remove"
        cancelLabel="Cancel"
        onConfirm={() => undefined}
        trigger={<Button>Open confirmation</Button>}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Open confirmation" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
