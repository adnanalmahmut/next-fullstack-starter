import "@testing-library/jest-dom/vitest";

import { act, cleanup, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect } from "vitest";

class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: ResizeObserverStub,
});

Object.defineProperty(globalThis, "PointerEvent", {
  configurable: true,
  value: MouseEvent,
});

Object.defineProperties(Element.prototype, {
  scrollIntoView: {
    configurable: true,
    value: () => undefined,
  },
  hasPointerCapture: {
    configurable: true,
    value: () => false,
  },
  setPointerCapture: {
    configurable: true,
    value: () => undefined,
  },
  releasePointerCapture: {
    configurable: true,
    value: () => undefined,
  },
});

afterEach(async () => {
  act(() => {
    toast.dismiss();
    for (const activeToast of toast.getToasts()) {
      toast.dismiss(activeToast.id);
    }
  });

  await waitFor(() => {
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  });

  cleanup();
  document.documentElement.removeAttribute("dir");
});
