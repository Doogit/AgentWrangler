/**
 * test/ui/boot-shell.test.tsx — P1-U5: the production boot overlay is a pre-JS paint
 * only. Its readiness/status polling, escalation and scan log are intentionally
 * removed (they live in the shell StatusChip now); main.tsx mounts at once and App
 * dismisses the overlay on its first commit via window.__awBoot.reveal().
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createRoot, render } = vi.hoisted(() => ({
  createRoot: vi.fn(),
  render: vi.fn(),
}));
vi.mock("react-dom/client", () => ({ createRoot }));
vi.mock("../../src/ui/App", () => ({ default: () => null }));
vi.mock("../../src/ui/lib/theme", () => ({ initTheme: vi.fn() }));

function installProductionShell() {
  const html = readFileSync(resolve(process.cwd(), "src/ui/index.html"), "utf8");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  const controller = Array.from(parsed.querySelectorAll("script")).find((script) =>
    script.textContent?.includes("__awBoot"),
  );
  if (!controller?.textContent) throw new Error("Production boot script missing");
  new Function(controller.textContent)();
  const overlay = document.getElementById("boot-overlay");
  if (!overlay) throw new Error("Production boot overlay missing");
  return overlay;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  createRoot.mockReturnValue({ render });
  createRoot.mockClear();
  render.mockClear();
  fetchMock = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
});

afterEach(() => {
  Reflect.deleteProperty(window, "__awBoot");
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("production boot shell and main entry (P1-U5)", () => {
  it("paints a static overlay that makes no requests", () => {
    const overlay = installProductionShell();
    expect(overlay.textContent).toContain("AgentWrangler");
    expect(overlay.querySelector("[data-aw-boot-log]")).toBeNull();
    expect(overlay.querySelector("[data-aw-boot-error]")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mounts the app at once, without waiting for /api/ready", async () => {
    installProductionShell();
    await import("../../src/ui/main");
    expect(createRoot).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reveal() removes the overlay and is safe to call twice", () => {
    installProductionShell();
    window.__awBoot?.reveal();
    expect(document.getElementById("boot-overlay")).toBeNull();
    expect(() => window.__awBoot?.reveal()).not.toThrow();
  });
});
