import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Sidebar from "../../src/ui/nav/Sidebar";
import Modal from "../../src/ui/shell/Modal";

vi.mock("../../src/ui/api/client", () => ({
  fetchStatus: () => Promise.resolve({ data: {} }),
  getLastFetchTimestamp: () => undefined,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("closes mobile navigation on selection or Escape and returns focus to its toggle", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const navigate = vi.fn();
  render(<Sidebar active="sessions" onNavigate={navigate} />);
  const menu = screen.getByRole("button", { name: "Menu" });
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("button", { name: "Sessions" }).getAttribute("aria-current")).toBe(
    "page",
  );
  fireEvent.click(menu);
  fireEvent.click(screen.getByRole("button", { name: "Recommendations" }));
  expect(navigate).toHaveBeenCalledWith("recommendations");
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(menu);
  fireEvent.click(menu);
  fireEvent.keyDown(screen.getByRole("button", { name: "Settings" }), { key: "Escape" });
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(menu);
});

it("opens confirmations modally, delegates cancellation and restores the opener", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const cancel = vi.fn();
  const show = vi.spyOn(HTMLDialogElement.prototype, "showModal");
  const { unmount } = render(
    <Modal labelledBy="title" onCancel={cancel}>
      <h2 id="title">Confirm action</h2>
      <button type="button">Cancel</button>
    </Modal>,
  );
  expect(show).toHaveBeenCalledOnce();
  const dialog = screen.getByRole("dialog", { name: "Confirm action" });
  fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
  expect(cancel).toHaveBeenCalledOnce();
  unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
  show.mockRestore();
});
