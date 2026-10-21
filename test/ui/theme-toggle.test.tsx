import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStoredTheme, initTheme, setTheme } from "../../src/ui/lib/theme";
import Sidebar from "../../src/ui/nav/Sidebar";

vi.mock("../../src/ui/api/client", () => ({
  fetchStatus: () => Promise.resolve({ data: {} }),
  getLastFetchTimestamp: () => undefined,
}));

const KEY = "aw-theme";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const styles = fs.readFileSync(path.resolve(TEST_DIR, "../../src/ui/styles.css"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

const THEME_SWITCH_TOKENS = [
  "--theme-switch-bg",
  "--theme-switch-ink",
  "--theme-switch-border",
  "--theme-switch-hover",
];

function tokenValue(block: string, token: string): string {
  return block.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? "";
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex
      .slice(1)
      .match(/.{2}/g)
      ?.map((channel) => Number.parseInt(channel, 16) / 255);
    if (!channels || channels.length !== 3) return 0;
    const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("color-scheme");
});

afterEach(() => cleanup());

describe("theme module", () => {
  it("defaults to dark when nothing is stored and applies it to the root", () => {
    expect(getStoredTheme()).toBeNull();
    expect(initTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("reads and applies a stored light choice", () => {
    setTheme("light");
    expect(localStorage.getItem(KEY)).toBe("light");
    document.documentElement.removeAttribute("data-theme");
    expect(initTheme()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
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

  it("shows the destination icon and label in each active theme", () => {
    initTheme();
    render(<Sidebar active="overview" onNavigate={() => {}} />);

    const lightToggle = screen.getByRole("button", { name: "Switch to light theme" });
    expect(lightToggle.textContent).toContain("☀ Light theme");

    fireEvent.click(lightToggle);
    expect(screen.getByRole("button", { name: "Switch to dark theme" }).textContent).toContain(
      "☾ Dark theme",
    );
  });

  it("persists and applies keyboard-origin activation", () => {
    initTheme();
    render(<Sidebar active="overview" onNavigate={() => {}} />);
    const toggle = screen.getByRole("button", { name: "Switch to light theme" });

    toggle.focus();
    fireEvent.click(toggle, { detail: 0 });

    expect(document.activeElement).toBe(toggle);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(localStorage.getItem(KEY)).toBe("light");
  });
});

describe("theme switch styles", () => {
  it("defines every destination-theme token in both theme blocks", () => {
    const darkTheme = rule(":root");
    const lightTheme = rule(':root[data-theme="light"]');

    for (const token of THEME_SWITCH_TOKENS) {
      expect(darkTheme).toContain(`${token}:`);
      expect(lightTheme).toContain(`${token}:`);
    }
  });

  it("uses the paired tokens for the switch surface, ink, border, and hover", () => {
    const toggle = rule(".theme-toggle");
    const hover = rule(".theme-toggle:not(:disabled):hover");

    expect(toggle).toMatch(/background:\s*var\(--theme-switch-bg\)/);
    expect(toggle).toMatch(/color:\s*var\(--theme-switch-ink\)/);
    expect(toggle).toMatch(/border:\s*1px solid var\(--theme-switch-border\)/);
    expect(hover).toMatch(/background:\s*var\(--theme-switch-hover\)/);
    expect(hover).toMatch(/color:\s*var\(--theme-switch-ink\)/);
  });

  it("uses the destination palette with AA text and visible control contrast", () => {
    const darkTheme = rule(":root");
    const lightTheme = rule(':root[data-theme="light"]');
    const pairs = [
      { active: darkTheme, destination: lightTheme },
      { active: lightTheme, destination: darkTheme },
    ];

    for (const { active, destination } of pairs) {
      const background = tokenValue(active, "--theme-switch-bg");
      const ink = tokenValue(active, "--theme-switch-ink");
      const hover = tokenValue(active, "--theme-switch-hover");
      expect(background).toBe(tokenValue(destination, "--panel"));
      expect(ink).toBe(tokenValue(destination, "--text"));
      expect(contrastRatio(ink, background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ink, hover)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(background, tokenValue(active, "--bg"))).toBeGreaterThanOrEqual(3);
    }
  });
});
