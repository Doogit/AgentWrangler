import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HotSessionsPage from "../../src/ui/sessions/HotSessionsPage";
import EmptyState from "../../src/ui/shell/EmptyState";

const { fetchPage } = vi.hoisted(() => ({ fetchPage: vi.fn() }));
vi.mock("../../src/ui/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ui/api/client")>()),
  fetchHotSessionsPage: fetchPage,
}));

const writeText = vi.fn<() => Promise<void>>();
let clipboardDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  writeText.mockClear();
  writeText.mockResolvedValue(undefined);
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (clipboardDescriptor === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  }
});

describe("EmptyState", () => {
  it("renders every onboarding part and copies its command", () => {
    render(
      <EmptyState
        headline="Nothing recorded yet"
        why="The daemon has not observed a completed session."
        whatWillAppear="Session aggregates will appear after the next completed session."
        command="claude"
      />,
    );

    expect(screen.getByRole("heading", { name: "Nothing recorded yet" })).toBeTruthy();
    expect(screen.getByText("The daemon has not observed a completed session.")).toBeTruthy();
    expect(
      screen.getByText("Session aggregates will appear after the next completed session."),
    ).toBeTruthy();
    expect(screen.getByText("claude")).toBeTruthy();

    const copyButton = screen.getByRole("button", { name: "Copy command: claude" });
    expect(copyButton.classList).toContain("btn-secondary");
    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledWith("claude");
  });

  it("uses the sessions-specific onboarding copy for a loaded zero-row response", async () => {
    fetchPage.mockReset().mockResolvedValue({ rows: [], next_cursor: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));

    render(<HotSessionsPage onSelectSession={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "No session cost data yet" })).toBeTruthy();
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Loading the selected range\./)).toBeNull());
    expect(screen.getByText("No sessions with recorded turns in this range.")).toBeTruthy();
    expect(screen.getByText("Sessions with recorded turns will appear here.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy command: claude" })).toBeTruthy();
    expect(screen.queryByText("Nothing here")).toBeNull();
  });
});
