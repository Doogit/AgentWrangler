import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/ui/App";

vi.mock("../../src/ui/overview/OverviewPage", () => ({
  default: ({ onSelectSession }: { onSelectSession?: (sessionId: string) => void }) => (
    <main data-testid="page">
      <h1>Overview page</h1>
      <button type="button" onClick={() => onSelectSession?.("session-42")}>
        Open session
      </button>
    </main>
  ),
}));

vi.mock("../../src/ui/briefs/BriefsPage", () => ({
  default: () => (
    <main data-testid="page">
      <h1>Briefs page</h1>
    </main>
  ),
}));

vi.mock("../../src/ui/recommendations/RecommendationsPage", () => ({
  default: () => (
    <main data-testid="page">
      <h1>Recommendations page</h1>
    </main>
  ),
}));

vi.mock("../../src/ui/settings/SettingsPage", () => ({
  default: () => (
    <main data-testid="page">
      <h1>Settings page</h1>
    </main>
  ),
}));

vi.mock("../../src/ui/workspaces/WorkspacesPage", () => ({
  default: () => (
    <main data-testid="page">
      <h1>Workspaces page</h1>
    </main>
  ),
}));

vi.mock("../../src/ui/sessions/HotSessionsPage.js", () => ({
  default: ({ onSelectSession }: { onSelectSession?: (sessionId: string) => void }) => (
    <main data-testid="page">
      <h1>Sessions page</h1>
      <button type="button" onClick={() => onSelectSession?.("session-42")}>
        Open session from list
      </button>
    </main>
  ),
}));

vi.mock("../../src/ui/sessions/SessionDetailPage", () => ({
  default: ({ sessionId, onBack }: { sessionId: string; onBack: () => void }) => (
    <main data-testid="page">
      <h1>Session detail page</h1>
      <output data-testid="session-id">{sessionId}</output>
      <button type="button" onClick={onBack}>
        Back
      </button>
    </main>
  ),
}));

afterEach(() => cleanup());

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
  it.each([
    ["#/overview", "Overview page"],
    ["#/briefs", "Briefs page"],
    ["#/recommendations", "Recommendations page"],
    ["#/workspaces", "Workspaces page"],
    ["#/settings", "Settings page"],
  ])("renders %s as %s", (hash, page) => {
    replaceHash(hash);
    render(<App />);

    expect(screen.getByRole("heading", { name: page })).toBeTruthy();
  });

  it.each(["", "#/unknown", "#/sessions/", "#/sessions/%E0%A4%A"])(
    'falls back to overview for "%s"',
    (hash) => {
      replaceHash(hash);
      render(<App />);

      expect(screen.getByRole("heading", { name: "Overview page" })).toBeTruthy();
    },
  );

  it("renders a session detail route with its session id", () => {
    replaceHash("#/sessions/session-123");
    render(<App />);

    expect(screen.getByRole("heading", { name: "Session detail page" })).toBeTruthy();
    expect(screen.getByTestId("session-id").textContent).toBe("session-123");
  });

  it("decodes an encoded session id from the hash", () => {
    replaceHash("#/sessions/session%2F123%20details");
    render(<App />);

    expect(screen.getByTestId("session-id").textContent).toBe("session/123 details");
  });

  it("updates the rendered page when the hash changes", async () => {
    replaceHash("#/overview");
    render(<App />);

    dispatchHashChange("#/recommendations");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Recommendations page" })).toBeTruthy();
    });
  });

  it("writes navigation, session-open, and back hashes", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Recommendations" }));
    await waitFor(() => expect(window.location.hash).toBe("#/recommendations"));

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Overview page" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions/session-42");
      expect(screen.getByRole("heading", { name: "Session detail page" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(window.location.hash).toBe("#/sessions"));
  });
});
