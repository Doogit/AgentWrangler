import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStoredTheme, initTheme, setTheme } from "../../src/ui/lib/theme";
import Sidebar from "../../src/ui/nav/Sidebar";

vi.mock("../../src/ui/api/client", () => ({
  fetchStatus: () => Promise.resolve({ data: {} }),
  getLastFetchTimestamp: () => undefined,
}));

const KEY = "aw-theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => cleanup());

describe("theme module", () => {
  it("defaults to dark when nothing is stored and applies it to the root", () => {
    expect(getStoredTheme()).toBeNull();
    expect(initTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("reads and applies a stored light choice", () => {
    setTheme("light");
    expect(localStorage.getItem(KEY)).toBe("light");
    document.documentElement.removeAttribute("data-theme");
    expect(initTheme()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("ignores a garbage stored value and falls back to dark", () => {
    localStorage.setItem(KEY, "chartreuse");
    expect(getStoredTheme()).toBeNull();
    expect(initTheme()).toBe("dark");
  });

  it("falls back to dark when localStorage throws (private mode)", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(getStoredTheme()).toBeNull();
    expect(initTheme()).toBe("dark");
    spy.mockRestore();
  });
});

describe("sidebar theme toggle", () => {
  it("flips data-theme and persists the choice on click", () => {
    initTheme(); // dark default
    render(<Sidebar active="overview" onNavigate={() => {}} />);
    const toggle = screen.getByRole("button", { name: "Switch to light theme" });

    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(KEY)).toBe("light");
    expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(KEY)).toBe("dark");
  });
});
