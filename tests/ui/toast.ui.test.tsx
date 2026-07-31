import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";

import { Toaster } from "@/ui/primitives/sonner";

describe("Toaster", () => {
  it.each(["ltr", "rtl"] as const)(
    "renders caller-provided live content in %s",
    async (direction) => {
      render(<Toaster dir={direction} />);
      toast.success(`Saved ${direction}`);

      expect(await screen.findByText(`Saved ${direction}`)).toBeVisible();
      expect(document.querySelector("[data-sonner-toaster]")).toHaveAttribute(
        "dir",
        direction,
      );
      expect(document.querySelector("[data-sonner-toaster]")).toHaveStyle({
        zIndex: "var(--layer-toast)",
      });
      expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
        `Saved ${direction}`,
      );
    },
  );

  it("does not render a default message", () => {
    render(<Toaster />);

    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  });

  it("does not expose a dismissed toast after remounting", async () => {
    const firstRender = render(<Toaster />);

    toast.success("Previous notification");
    expect(await screen.findByText("Previous notification")).toBeVisible();

    act(() => {
      toast.dismiss();
      for (const activeToast of toast.getToasts()) {
        toast.dismiss(activeToast.id);
      }
    });
    await waitFor(() => {
      expect(
        screen.queryByText("Previous notification"),
      ).not.toBeInTheDocument();
    });

    firstRender.unmount();
    render(<Toaster />);

    expect(screen.queryByText("Previous notification")).not.toBeInTheDocument();
    expect(toast.getToasts()).toHaveLength(0);
  });
});
