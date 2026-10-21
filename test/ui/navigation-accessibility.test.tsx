import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Sidebar from "../../src/ui/nav/Sidebar";
import Modal from "../../src/ui/shell/Modal";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const styles = fs.readFileSync(path.resolve(TEST_DIR, "../../src/ui/styles.css"), "utf8");

vi.mock("../../src/ui/api/client", () => ({
  fetchStatus: () => Promise.resolve({ data: {} }),
  getLastFetchTimestamp: () => undefined,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("grouped sidebar navigation", () => {
  it("renders the task groups as labelled link lists in the requested order", () => {
    render(<Sidebar active="overview" onNavigate={() => {}} />);

    const expectedGroups = [
      ["Observe", ["Overview", "Workspaces", "Sessions"]],
      ["Analyze", ["Rate my setup", "Usage patterns", "Recommendations"]],
      ["Configure", ["Settings"]],
    ] as const;

    const groups = screen.getAllByRole("region");
    expect(groups).toHaveLength(3);
    for (const [index, [label, routes]] of expectedGroups.entries()) {
      const group = groups[index];
      expect(screen.getByRole("region", { name: label })).toBe(group);
      expect(group?.querySelectorAll("ul")).toHaveLength(1);
      expect(group?.querySelectorAll("li")).toHaveLength(routes.length);
      const links = Array.from(group?.querySelectorAll("a") ?? []);
      expect(links.map((link) => link.textContent?.replace("EXP", "").trim())).toEqual(routes);
      expect(links.map((link) => link.getAttribute("href"))).toEqual(
        routes.map(
          (route) =>
            // "Rate my setup" and "Usage patterns" are visible labels; their routes keep the internal names.
            `#/${route === "Rate my setup" ? "judge-setup" : route === "Usage patterns" ? "diagnostics" : route.toLowerCase().replaceAll(" ", "-")}`,
        ),
      );
    }

    expect(screen.getByRole("link", { name: /how to read this dashboard/i })).toBeTruthy();
  });

  it("marks parent links current for detail routes", () => {
    const { rerender } = render(<Sidebar active="session-detail" onNavigate={() => {}} />);
    expect(screen.getByRole("link", { name: "Sessions" }).getAttribute("aria-current")).toBe(
      "page",
    );

    rerender(<Sidebar active="workspace-detail" onNavigate={() => {}} />);
    expect(screen.getByRole("link", { name: /Workspaces/ }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("keeps modified link activation native instead of forcing same-tab navigation", () => {
    const navigate = vi.fn();
    render(<Sidebar active="overview" onNavigate={navigate} />);

    fireEvent.click(screen.getByRole("link", { name: "Sessions" }), { ctrlKey: true });
    fireEvent.click(screen.getByRole("link", { name: "Rate my setup" }), { metaKey: true });

    expect(navigate).not.toHaveBeenCalled();
  });
});

function renderMobileSidebar(onNavigate = vi.fn()) {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  render(<Sidebar active="sessions" onNavigate={onNavigate} />);
  const menu = screen.getByRole("button", { name: "Menu" });
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(menu.getAttribute("aria-controls")).toBe("main-navigation-links");
  expect(document.getElementById("main-navigation-links")).toBeTruthy();
  return { menu, onNavigate };
}

it("closes mobile navigation on route selection without returning focus to Menu", () => {
  const { menu, onNavigate } = renderMobileSidebar();
  expect(screen.getByRole("link", { name: "Sessions" }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(menu);
  const destination = screen.getByRole("link", { name: "Recommendations" });
  destination.focus();
  fireEvent.click(destination);
  expect(onNavigate).toHaveBeenCalledWith("recommendations");
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(destination);
});

it("returns focus to Menu when Escape or the toggle closes mobile navigation", () => {
  const { menu } = renderMobileSidebar();
  fireEvent.click(menu);
  const settings = screen.getByRole("link", { name: "Settings" });
  settings.focus();
  fireEvent.keyDown(settings, { key: "Escape" });
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(menu);

  fireEvent.click(menu);
  const close = screen.getByRole("button", { name: "Close menu" });
  fireEvent.click(close);
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(menu);
});

it("closes on outside pointer activation without stealing focus from the activated target", () => {
  const outside = document.createElement("button");
  outside.textContent = "Outside action";
  document.body.append(outside);
  const { menu } = renderMobileSidebar();
  fireEvent.click(menu);
  outside.focus();

  fireEvent.pointerDown(outside);

  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(outside);
  outside.remove();
});

describe("bounded mobile navigation styles", () => {
  it("bounds and scrolls the disclosure while preserving minimum target sizes", () => {
    const mobile = styles.match(/@media \(max-width: 800px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(mobile).toMatch(/\.sidebar-links\.is-open\s*\{[^}]*max-height:/s);
    expect(mobile).toMatch(/\.sidebar-links\.is-open\s*\{[^}]*overflow-y:\s*auto/s);
    expect(mobile).toMatch(/\.mobile-nav-toggle\s*\{[^}]*min-height:\s*(?:2[4-9]|[3-9]\d)px/s);
    expect(mobile).toMatch(
      /\.nav-link,\s*\.theme-toggle\s*\{[^}]*min-height:\s*(?:2[4-9]|[3-9]\d)px/s,
    );
  });
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
