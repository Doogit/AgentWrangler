import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App, { parseHash } from "../../src/ui/App";
import HelpPage from "../../src/ui/help/HelpPage";
import { helpRoute, topics } from "../../src/ui/help/topics";

vi.mock("../../src/ui/api/client", () => ({
  isDaemonUnreachableError: () => true,
  fetchStatus: () => Promise.reject(new Error("offline")),
  getLastFetchTimestamp: () => undefined,
}));
vi.mock("../../src/ui/shell/PipelineStatusBar", () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("bundled Help", () => {
  it("allowlists topics and sections, keeping unknown input on a useful page", () => {
    expect(parseHash("#/help?topic=sessions").route).toBe("help");
    expect(helpRoute("#/help?topic=not-real&section=privacy").topic).toBeUndefined();
    expect(helpRoute("#/help?topic=sessions&section=privacy").section).toBeUndefined();
    render(<HelpPage hash="#/help?topic=not-real" />);
    expect(screen.getByRole("heading", { name: "Help", level: 1 })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start here" })).toBeTruthy();
  });

  it("resolves every authored app link and section destination", () => {
    const hashes = ["#/help", ...topics.map((topic) => `#/help?topic=${topic.id}`)];
    const settingsSections = new Set([
      "scan-roots",
      "calibration",
      "outcomes-sync",
      "in-session-guards",
      "parser-health",
    ]);
    for (const hash of hashes) {
      const { container, unmount } = render(<HelpPage hash={hash} />);
      for (const anchor of container.querySelectorAll<HTMLAnchorElement>("a")) {
        const href = anchor.getAttribute("href") ?? "";
        if (!href.startsWith("#")) {
          expect(href.startsWith("https://github.com/Doogit/AgentWrangler")).toBe(true);
          continue;
        }
        const route = parseHash(href).route;
        expect(route === "overview" ? href === "#/overview" : true, href).toBe(true);
        const params = new URLSearchParams(href.split("?")[1]);
        if (route === "help" && params.has("topic")) {
          expect(helpRoute(href).topic, href).toBeDefined();
          if (params.has("section")) expect(helpRoute(href).section, href).toBeDefined();
        }
        if (route === "settings" && params.has("section"))
          expect(settingsSections.has(params.get("section") ?? "")).toBe(true);
      }
      unmount();
    }
  });

  it("focuses query-only navigation and same-destination activation without intercepting modified clicks", async () => {
    const hash = "#/help?topic=recommendations&section=measurement";
    const { rerender } = render(<HelpPage hash="#/help?topic=recommendations" />);
    expect(document.activeElement?.id).toBe("help-title");
    window.history.replaceState(null, "", hash);
    rerender(<HelpPage hash={hash} />);
    expect(document.activeElement?.id).toBe("help-measurement");
    const link = screen.getByRole("link", { name: "Return to inspect measurement" });
    link.focus();
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(document.activeElement).toBe(link);
    fireEvent.click(link);
    expect(document.activeElement?.id).toBe("help-measurement");
    // Let jsdom finish native anchor navigation before resetting history for the next test.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it("keeps Help available after analytics failure and follows hash history changes", async () => {
    window.history.replaceState(null, "", "#/help?topic=troubleshooting&section=daemon");
    render(<App />);
    await screen.findByRole("heading", { name: "Daemon unavailable, update or port conflict" });
    await waitFor(() => expect(document.activeElement?.id).toBe("help-daemon"));
    expect(screen.queryByRole("heading", { name: "Local daemon unavailable" })).toBeNull();
    act(() => {
      window.history.replaceState(null, "", "#/help?topic=sessions");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await screen.findByRole("heading", { name: "Sessions", level: 1 });
    expect(document.activeElement?.id).toBe("help-title");
    act(() => {
      window.history.replaceState(null, "", "#/help?topic=troubleshooting&section=daemon");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(document.activeElement?.id).toBe("help-daemon"));
  });
});
