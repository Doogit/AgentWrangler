import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/ui/App";

const recommendationsGate = vi.hoisted(() => ({
  promise: null as Promise<void> | null,
  release: null as (() => void) | null,
}));
const overviewGate = vi.hoisted(() => ({
  promise: null as Promise<void> | null,
  release: null as (() => void) | null,
}));

vi.mock("../../src/ui/overview/OverviewPage", () => ({
  default: ({ onSelectSession }: { onSelectSession?: (sessionId: string) => void }) => {
    if (overviewGate.promise !== null) throw overviewGate.promise;
    return (
      <section data-testid="page">
        <h1>Overview page</h1>
        <button type="button" onClick={() => onSelectSession?.("session-42")}>
          Open session
        </button>
      </section>
    );
  },
}));

vi.mock("../../src/ui/judge-setup/JudgeSetupPage", () => ({
  default: () => (
    <section data-testid="page">
      <h1>Judge setup page</h1>
    </section>
  ),
}));

vi.mock("../../src/ui/diagnostics/DiagnosticsPage", () => ({
  default: () => (
    <section data-testid="page">
      <h1>Diagnostics page</h1>
    </section>
  ),
}));

vi.mock("../../src/ui/recommendations/RecommendationsPage", () => ({
  default: () => {
    if (recommendationsGate.promise !== null) throw recommendationsGate.promise;
    return (
      <section data-testid="page">
        <h1>Recommendations page</h1>
      </section>
    );
  },
}));

vi.mock("../../src/ui/settings/SettingsPage", () => ({
  default: () => (
    <section data-testid="page">
      <h1>Settings page</h1>
    </section>
  ),
}));

vi.mock("../../src/ui/workspaces/WorkspacesPage", () => ({
  default: () => (
    <section data-testid="page">
      <h1>Workspaces page</h1>
    </section>
  ),
}));

vi.mock("../../src/ui/sessions/HotSessionsPage.js", () => ({
  default: ({ onSelectSession }: { onSelectSession?: (sessionId: string) => void }) => (
    <section data-testid="page">
      <h1>Sessions page</h1>
      <button type="button" onClick={() => onSelectSession?.("session-42")}>
        Open session from list
      </button>
    </section>
  ),
}));

vi.mock("../../src/ui/sessions/SessionDetailPage", () => ({
  default: ({
    sessionId,
    onBack,
    backLabel,
    anchorMessageId,
    anchorTurnIndex,
  }: {
    sessionId: string;
    onBack: () => void;
    backLabel: string;
    anchorMessageId?: string | null;
    anchorTurnIndex?: number | null;
  }) => (
    <section data-testid="page">
      <h1>Session detail page</h1>
      <output data-testid="session-id">{sessionId}</output>
      <output data-testid="session-anchor">
        {anchorMessageId ?? ""}:{anchorTurnIndex ?? ""}
      </output>
      <button type="button" onClick={onBack}>
        {backLabel}
      </button>
    </section>
  ),
}));

afterEach(() => {
  cleanup();
  overviewGate.promise = null;
  overviewGate.release = null;
  recommendationsGate.promise = null;
  recommendationsGate.release = null;
  vi.unstubAllGlobals();
});

function replaceHash(hash: string) {
  window.history.replaceState(null, "", hash === "" ? "/" : hash);
}

function dispatchHashChange(hash: string) {
  replaceHash(hash);
  window.dispatchEvent(new Event("hashchange"));
}

beforeEach(() => {
  replaceHash("");
});

describe("dashboard hash routing", () => {
  it("renders a first-focusable skip link targeting the semantic main landmark", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: "Overview page" });
    const skipLink = screen.getByRole("link", { name: "Skip to main content" });
    const main = screen.getByRole("main");
    expect(document.querySelectorAll("a, button, input, select, textarea, [tabindex]")[0]).toBe(
      skipLink,
    );
    expect(skipLink.getAttribute("href")).toBe("#main-content");
    expect(main.id).toBe("main-content");
    expect(main.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(skipLink);
    expect(document.activeElement).toBe(main);
  });

  it("does not move focus when the initial lazy destination commits", async () => {
    overviewGate.promise = new Promise<void>((resolve) => {
      overviewGate.release = () => {
        overviewGate.promise = null;
        resolve();
      };
    });
    const sentinel = document.createElement("button");
    sentinel.textContent = "Existing focus";
    document.body.append(sentinel);
    sentinel.focus();

    const { rerender } = render(<App />);
    await Promise.resolve();
    rerender(<App />);
    overviewGate.release?.();
    await screen.findByRole("heading", { name: "Overview page" });

    expect(document.activeElement).toBe(sentinel);
    sentinel.remove();
  });

  it.each([
    ["#/overview", "Overview page"],
    ["#/judge-setup", "Judge setup page"],
    ["#/briefs", "Judge setup page"],
    ["#/recommendations", "Recommendations page"],
    ["#/workspaces", "Workspaces page"],
    ["#/settings", "Settings page"],
  ])("renders %s as %s", async (hash, page) => {
    replaceHash(hash);
    render(<App />);

    expect(await screen.findByRole("heading", { name: page })).toBeTruthy();
  });

  it("rewrites the retired #/briefs hash to #/judge-setup", async () => {
    replaceHash("#/briefs");
    render(<App />);

    await screen.findByRole("heading", { name: "Judge setup page" });
    await waitFor(() => expect(window.location.hash).toBe("#/judge-setup"));
  });

  it.each(["", "#/unknown", "#/sessions/", "#/sessions/%E0%A4%A"])(
    'falls back to overview for "%s"',
    async (hash) => {
      replaceHash(hash);
      render(<App />);

      expect(await screen.findByRole("heading", { name: "Overview page" })).toBeTruthy();
    },
  );

  it("renders a session detail route with its session id", async () => {
    replaceHash("#/sessions/session-123");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Session detail page" })).toBeTruthy();
    expect(screen.getByTestId("session-id").textContent).toBe("session-123");
    expect(screen.getByTestId("session-anchor").textContent).toBe(":");
    expect(screen.getByRole("button", { name: "Back to sessions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await waitFor(() => expect(window.location.hash).toBe("#/sessions"));
  });

  it("decodes an encoded session id from the hash", async () => {
    replaceHash("#/sessions/session%2F123%20details");
    render(<App />);

    expect((await screen.findByTestId("session-id")).textContent).toBe("session/123 details");
  });

  it("passes diagnostic anchor and turn offsets into session detail", async () => {
    replaceHash("#/sessions/session-123?anchor=message-7&turn=8");
    render(<App />);
    expect((await screen.findByTestId("session-anchor")).textContent).toBe("message-7:8");
  });

  it("does not coerce an empty diagnostic turn offset to zero", async () => {
    replaceHash("#/sessions/session-123?turn=");
    render(<App />);
    expect((await screen.findByTestId("session-anchor")).textContent).toBe(":");
  });

  it("updates the rendered page when the hash changes", async () => {
    replaceHash("#/overview");
    render(<App />);

    dispatchHashChange("#/recommendations");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Recommendations page" })).toBeTruthy();
    });
  });

  it("focuses the destination heading only after route content has committed", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    replaceHash("#/overview");
    render(<App />);
    await screen.findByRole("heading", { name: "Overview page" });

    recommendationsGate.promise = new Promise<void>((resolve) => {
      recommendationsGate.release = () => {
        recommendationsGate.promise = null;
        resolve();
      };
    });

    const menu = screen.getByRole("button", { name: "Menu" });
    fireEvent.click(menu);
    const destination = screen.getByRole("link", { name: "Recommendations" });
    destination.focus();
    fireEvent.click(destination);

    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(destination);
    expect(screen.queryByRole("heading", { name: "Recommendations page" })).toBeNull();
    recommendationsGate.release?.();
    const heading = await screen.findByRole("heading", { name: "Recommendations page" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });

  it("refocuses the destination when only a detail route parameter changes", async () => {
    replaceHash("#/sessions");
    render(<App />);
    await screen.findByRole("heading", { name: "Sessions page" });
    dispatchHashChange("#/sessions/session-a");
    await screen.findByText("session-a");

    const backButton = screen.getByRole("button", { name: "Back to sessions" });
    backButton.focus();
    dispatchHashChange("#/sessions/session-b");

    await screen.findByText("session-b");
    const heading = screen.getByRole("heading", { name: "Session detail page" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });

  it("preserves control focus when only route query state changes", async () => {
    replaceHash("#/overview");
    render(<App />);
    dispatchHashChange("#/sessions");
    await screen.findByRole("heading", { name: "Sessions page" });

    const control = screen.getByRole("button", { name: "Open session from list" });
    control.focus();
    dispatchHashChange("#/sessions?sort=cost");

    await waitFor(() => expect(window.location.hash).toBe("#/sessions?sort=cost"));
    expect(document.activeElement).toBe(control);
  });

  it("preserves control focus when the first hash change is query-only", async () => {
    replaceHash("#/sessions");
    render(<App />);
    await screen.findByRole("heading", { name: "Sessions page" });

    const control = screen.getByRole("button", { name: "Open session from list" });
    control.focus();
    dispatchHashChange("#/sessions?sort=cost");

    await waitFor(() => expect(window.location.hash).toBe("#/sessions?sort=cost"));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(control);
  });

  it("writes navigation, session-open, and back hashes", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("link", { name: "Recommendations" }));
    await waitFor(() => expect(window.location.hash).toBe("#/recommendations"));

    fireEvent.click(screen.getByRole("link", { name: "Overview" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Overview page" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions/session-42");
      expect(screen.getByRole("heading", { name: "Session detail page" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Back to overview" }));
    await waitFor(() => expect(window.location.hash).toBe("#/overview"));
  });

  it("back from session opened via sessions list returns to #/sessions", async () => {
    render(<App />);

    dispatchHashChange("#/sessions");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Sessions page" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open session from list" }));
    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions/session-42");
      expect(screen.getByRole("heading", { name: "Session detail page" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await waitFor(() => expect(window.location.hash).toBe("#/sessions"));
  });

  it("returns to the full prior sessions hash with a matching label", async () => {
    replaceHash("#/sessions?sort=cost&window=14");
    render(<App />);
    await screen.findByRole("heading", { name: "Sessions page" });
    fireEvent.click(screen.getByRole("button", { name: "Open session from list" }));
    const back = await screen.findByRole("button", { name: "Back to sessions" });
    fireEvent.click(back);
    await waitFor(() => expect(window.location.hash).toBe("#/sessions?sort=cost&window=14"));
  });

  it.each([
    ["#/overview?window=14", "Back to overview"],
    ["#/diagnostics?window=14", "Back to usage patterns"],
    ["#/recommendations?focus=synthetic", "Back to recommendations"],
    ["#/workspaces?sort=cost", "Back to workspaces"],
    ["#/settings?tab=privacy", "Back"],
  ])("labels the prior %s route and restores it", async (priorHash, label) => {
    replaceHash(priorHash);
    render(<App />);
    await screen.findByTestId("page");
    dispatchHashChange("#/sessions/session-42");
    const back = await screen.findByRole("button", { name: label });
    fireEvent.click(back);
    await waitFor(() => expect(window.location.hash).toBe(priorHash));
  });
});
