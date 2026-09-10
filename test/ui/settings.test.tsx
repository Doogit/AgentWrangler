/**
 * test/ui/settings.test.tsx — Settings surface (WP4) UI tests.
 *
 * Covers:
 *   - Parser-health counters render when data loads
 *   - DB-reset confirm button is disabled until the exact DB name is typed
 *   - DB-reset confirm button becomes enabled once the exact name matches
 *   - An invalid path save surfaces an inline error (not a silent no-op)
 *   - Saving a limit calls saveSettings with the expected payload
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockCalibrateLimit, mockSettings, mockWorkspaces } from "../../src/ui/api/fixtures";
import { __resetWorkspaceNamesCache } from "../../src/ui/lib/workspace-names";
import SettingsPage from "../../src/ui/settings/SettingsPage";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
});

function setupSuccess() {
  vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
  vi.mocked(client.saveSettings).mockResolvedValue(mockSettings());
  vi.mocked(client.resetDatabase).mockResolvedValue(mockSettings());
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe("SettingsPage — loading state", () => {
  it("shows aria-busy skeleton while loading", () => {
    vi.mocked(client.fetchSettings).mockReturnValue(new Promise(() => {}));
    const { container } = render(<SettingsPage />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

describe("SettingsPage — error state", () => {
  it("shows error banner when fetch fails", async () => {
    vi.mocked(client.fetchSettings).mockRejectedValue(new Error("ECONNREFUSED"));
    const { container } = render(<SettingsPage />);
    await waitFor(() => {
      expect(container.querySelector(".banner-error")).not.toBeNull();
    });
  });
});

describe("SettingsPage — UIR-10 grouping", () => {
  it("renders the four settings groups in the operator-facing order", async () => {
    setupSuccess();
    render(<SettingsPage />);

    await screen.findByRole("heading", { name: "Essentials" });
    expect(
      screen
        .getAllByRole("heading", { name: /Essentials|In-session guards|Integrations|Advanced/ })
        .map((heading) => heading.textContent),
    ).toEqual(["Essentials", "In-session guards", "Integrations", "Advanced"]);
  });

  it("keeps Advanced collapsed until the operator opens it", async () => {
    setupSuccess();
    const { container } = render(<SettingsPage />);
    await screen.findByRole("heading", { name: "Advanced" });

    const details = container.querySelector<HTMLDetailsElement>("#settings-advanced details");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
  });

  it("shows auto-derived workspace names and no idle-session UUID list", async () => {
    setupSuccess();
    render(<SettingsPage />);

    expect(await screen.findByLabelText("Auto-derived workspace names")).toBeTruthy();
    expect(screen.queryByText("sess-live-interactive")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Parser health panel
// ---------------------------------------------------------------------------

describe("SettingsPage — parser health", () => {
  it("renders parser-health counter values from fixture", async () => {
    setupSuccess();
    render(<SettingsPage />);

    // Fixture: files_seen=146, files_parsed=124, lines_quarantined=0
    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/146/);
      expect(text).toMatch(/124/);
    });
  });

  it("renders parser coverage without exposing the parser version identifier", async () => {
    setupSuccess();
    render(<SettingsPage />);
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/124 parsed files/);
    });
    expect(document.body.textContent).not.toMatch(/ingest-1/);
    expect(document.querySelector("[title='Parser versions: ingest-1: 124']")).not.toBeNull();
  });
});

describe("SettingsPage — getting started onboarding", () => {
  it("shows for either empty condition and hides once data exists", async () => {
    const emptyScanRoots = mockSettings();
    if (emptyScanRoots.data === null) throw new Error("settings fixture must have data");
    emptyScanRoots.data = {
      ...emptyScanRoots.data,
      scan_roots: [],
      parser_health: { ...emptyScanRoots.data.parser_health, files_seen: 42 },
    };
    vi.mocked(client.fetchSettings).mockResolvedValueOnce(emptyScanRoots);

    const first = render(<SettingsPage />);
    await waitFor(() => screen.getByRole("heading", { name: "Getting started" }));
    expect(screen.getByText(/first-run progress and next steps on Overview/i)).toBeTruthy();
    first.unmount();

    const emptyFilesSeen = mockSettings();
    if (emptyFilesSeen.data === null) throw new Error("settings fixture must have data");
    emptyFilesSeen.data = {
      ...emptyFilesSeen.data,
      scan_roots: ["/home/user/.claude/projects"],
      parser_health: { ...emptyFilesSeen.data.parser_health, files_seen: 0 },
    };
    vi.mocked(client.fetchSettings).mockResolvedValueOnce(emptyFilesSeen);

    const second = render(<SettingsPage />);
    await waitFor(() => screen.getByRole("heading", { name: "Getting started" }));
    second.unmount();

    vi.mocked(client.fetchSettings).mockResolvedValueOnce(mockSettings());
    const populated = render(<SettingsPage />);
    await waitFor(() => screen.getByRole("heading", { name: /Parser Health/ }));
    expect(screen.queryByRole("heading", { name: "Getting started" })).toBeNull();
    populated.unmount();
  });
});

describe("SettingsPage — parse failures", () => {
  it("renders the latest quarantined pointer panel without raw content or file actions", async () => {
    const settings = mockSettings();
    if (settings.data === null) throw new Error("settings fixture must have data");
    const row = settings.data.quarantine_rows[0];
    if (row === undefined) throw new Error("settings fixture must include a quarantine row");
    const rawSentinelRow = row as typeof row & { raw_content: string };
    rawSentinelRow.raw_content = "RAW_TRANSCRIPT_SENTINEL";
    vi.mocked(client.fetchSettings).mockResolvedValue(settings);
    vi.mocked(client.saveSettings).mockResolvedValue(settings);
    vi.mocked(client.resetDatabase).mockResolvedValue(settings);
    render(<SettingsPage />);

    await waitFor(() => screen.getByRole("heading", { name: "Parse Failures" }));
    expect(screen.getByText(/Latest 100 first-quarantined pointers/)).toBeTruthy();
    expect(document.body.textContent).toContain("/home/user/.claude/projects/example.jsonl:17");
    expect(document.body.textContent).toContain("MalformedJson");
    expect(document.body.textContent).toContain("2026-08-23T23:59:00Z");
    expect(document.body.textContent).not.toContain("RAW_TRANSCRIPT_SENTINEL");
    expect(screen.queryByRole("button", { name: /open|preview|view/i })).toBeNull();
  });

  it("hides the parse-failures panel when no rows are returned", async () => {
    const empty = mockSettings();
    if (empty.data === null) throw new Error("settings fixture must have data");
    empty.data.quarantine_rows = [];
    vi.mocked(client.fetchSettings).mockResolvedValue(empty);
    vi.mocked(client.saveSettings).mockResolvedValue(empty);
    vi.mocked(client.resetDatabase).mockResolvedValue(empty);
    render(<SettingsPage />);

    await waitFor(() => screen.getByRole("heading", { name: /Parser Health/ }));
    expect(screen.queryByRole("heading", { name: "Parse Failures" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DB-reset modal
// ---------------------------------------------------------------------------

describe("SettingsPage — DB-reset modal", () => {
  it("confirm button is disabled before any text is typed", async () => {
    setupSuccess();
    render(<SettingsPage />);

    // Wait for settings to load
    await waitFor(() => screen.getByText(/Reset database…/i));

    // Open the modal
    fireEvent.click(screen.getByText(/Reset database…/i));

    // The confirm button should exist and be disabled
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /^Reset database$/i });
      expect(btn).toBeTruthy();
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("confirm button remains disabled when incorrect text is typed", async () => {
    setupSuccess();
    render(<SettingsPage />);

    await waitFor(() => screen.getByText(/Reset database…/i));
    fireEvent.click(screen.getByText(/Reset database…/i));

    await waitFor(() => screen.getByRole("button", { name: /^Reset database$/i }));

    const input = screen.getByRole("textbox", { name: /Type the database name/i });
    fireEvent.change(input, { target: { value: "wrong-name" } });

    const btn = screen.getByRole("button", { name: /^Reset database$/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirm button becomes enabled when the exact DB basename is typed", async () => {
    setupSuccess();
    render(<SettingsPage />);

    // Fixture db_path = "/home/user/.agentwrangler/db.sqlite" → basename "db.sqlite"
    await waitFor(() => screen.getByText(/Reset database…/i));
    fireEvent.click(screen.getByText(/Reset database…/i));

    await waitFor(() => screen.getByRole("button", { name: /^Reset database$/i }));

    const input = screen.getByRole("textbox", { name: /Type the database name/i });
    fireEvent.change(input, { target: { value: "db.sqlite" } });

    const btn = screen.getByRole("button", { name: /^Reset database$/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("confirm button stays disabled for a wrong-case DB name (exact match required)", async () => {
    setupSuccess();
    render(<SettingsPage />);

    // Fixture db basename is "db.sqlite"; "DB.SQLITE" must NOT satisfy the gate.
    await waitFor(() => screen.getByText(/Reset database…/i));
    fireEvent.click(screen.getByText(/Reset database…/i));

    await waitFor(() => screen.getByRole("button", { name: /^Reset database$/i }));

    const input = screen.getByRole("textbox", { name: /Type the database name/i });
    fireEvent.change(input, { target: { value: "DB.SQLITE" } });

    const btn = screen.getByRole("button", { name: /^Reset database$/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("cancel closes the modal", async () => {
    setupSuccess();
    render(<SettingsPage />);

    await waitFor(() => screen.getByText(/Reset database…/i));
    fireEvent.click(screen.getByText(/Reset database…/i));

    await waitFor(() => screen.getByRole("button", { name: /Cancel/i }));
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    // Modal should be gone
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Workspace names — automatically derived from observed workspaces
// ---------------------------------------------------------------------------

describe("SettingsPage — workspace names summary", () => {
  it("renders the derived owner/name label, not the raw slug or empty-state copy", async () => {
    __resetWorkspaceNamesCache();
    setupSuccess();
    vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "30d" }));
    render(<SettingsPage />);

    const summary = await screen.findByLabelText("Auto-derived workspace names");
    await waitFor(() => expect(summary.textContent).toContain("acme/orbit-api"));
    expect(summary.textContent).not.toContain(
      "Workspace names appear after AgentWrangler observes a working directory.",
    );
  });
});

// ---------------------------------------------------------------------------
// Config form — invalid path shows inline error
// ---------------------------------------------------------------------------

describe("SettingsPage — config form validation", () => {
  it("surfaces an inline error when saveSettings rejects (not a silent no-op)", async () => {
    setupSuccess();
    vi.mocked(client.saveSettings).mockRejectedValue(
      new Error('Scan root "relative/path" is not an absolute path.'),
    );

    const { container } = render(<SettingsPage />);

    await waitFor(() => screen.getByRole("button", { name: /Save config/i }));
    fireEvent.click(screen.getByRole("button", { name: /Save config/i }));

    await waitFor(() => {
      const errEl = container.querySelector(".settings-inline-error");
      expect(errEl).not.toBeNull();
      expect(errEl?.textContent).toMatch(/not an absolute path/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Config form — saving limit_tokens calls client with correct payload
// ---------------------------------------------------------------------------

describe("SettingsPage — config form save", () => {
  it("blocks save with an inline error when activity window is below 1", async () => {
    setupSuccess();
    const { container } = render(<SettingsPage />);

    await waitFor(() => screen.getByRole("button", { name: /Save config/i }));

    const windowInput = screen.getByLabelText(/Activity window/i);
    fireEvent.change(windowInput, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /Save config/i }));

    await waitFor(() => {
      const errEl = container.querySelector(".settings-inline-error");
      expect(errEl).not.toBeNull();
      expect(errEl?.textContent).toMatch(/activity window/i);
    });
    expect(vi.mocked(client.saveSettings)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Regression — Bug-1: Save after calibrate must not downgrade provenance
// ---------------------------------------------------------------------------

describe("SettingsPage — save preserves calibrated provenance", () => {
  it("omits limit_tokens from Save payload when manual field was not touched", async () => {
    // Settings loaded with a calibrated limit — the field shows the value but
    // the user has not typed into it. Saving other fields (scan_roots, window)
    // must NOT send limit_tokens, which would silently overwrite provenance to
    // "manual" and wipe limit_resets_at on the backend.
    const base = mockSettings();
    const baseData = base.data;
    if (baseData === null) throw new Error("mockSettings() returned null data");
    const calibratedData = {
      ...baseData,
      limit_tokens: 8_000_000_000,
      limit_provenance: "calibrated 2026-08-24 @ 25.0%",
      limit_resets_at: "2026-08-31T00:00:00Z",
    };
    vi.mocked(client.fetchSettings).mockResolvedValue({ ...base, data: calibratedData });
    vi.mocked(client.saveSettings).mockResolvedValue({ ...base, data: calibratedData });

    render(<SettingsPage />);
    await waitFor(() => screen.getByRole("button", { name: /Save config/i }));

    // Click Save without touching the limit input
    fireEvent.click(screen.getByRole("button", { name: /Save config/i }));

    await waitFor(() => expect(vi.mocked(client.saveSettings)).toHaveBeenCalled());

    const payload = vi.mocked(client.saveSettings).mock.calls[0]?.[0];
    expect(payload).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(payload, "limit_tokens")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression — Bug-2: Calibrate must refresh parent settings via onSaved
// ---------------------------------------------------------------------------

describe("SettingsPage — calibrate refreshes parent settings", () => {
  it("calls fetchSettings again after a successful calibrate to update parent", async () => {
    vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(client.saveSettings).mockResolvedValue(mockSettings());
    vi.mocked(client.calibrateLimitApi).mockResolvedValue(mockCalibrateLimit());

    render(<SettingsPage />);
    await waitFor(() => screen.getByRole("button", { name: /Calibrate from usage/i }));

    // Record call count after initial load
    const callsBefore = vi.mocked(client.fetchSettings).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /Calibrate from usage/i }));

    // After a successful calibrate, fetchSettings must be called again so the
    // parent receives the persisted limit_resets_at + provenance.
    await waitFor(() => {
      expect(vi.mocked(client.fetchSettings).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});

// ---------------------------------------------------------------------------
// Calibrate-primary UX (limit_tokens redesign)
// ---------------------------------------------------------------------------

describe("SettingsPage — calibrate-primary UX", () => {
  it("shows Calibrate from usage as the primary CTA without any toggle", async () => {
    setupSuccess();
    render(<SettingsPage />);
    // Button must be visible immediately — no expand/toggle required
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Calibrate from usage/i })).toBeTruthy();
    });
  });

  it("manual override input is always accessible in the DOM (no toggle required)", async () => {
    setupSuccess();
    render(<SettingsPage />);
    await waitFor(() => screen.getByRole("button", { name: /Calibrate from usage/i }));
    // Input must be reachable by its label — advanced section is always rendered
    expect(screen.getByLabelText(/Weekly token limit/i)).toBeTruthy();
  });

  it("shows Re-calibrate from usage after a successful calibration", async () => {
    vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(client.saveSettings).mockResolvedValue(mockSettings());
    vi.mocked(client.calibrateLimitApi).mockResolvedValue(mockCalibrateLimit());

    render(<SettingsPage />);
    await waitFor(() => screen.getByRole("button", { name: /Calibrate from usage/i }));

    fireEvent.click(screen.getByRole("button", { name: /Calibrate from usage/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Re-calibrate from usage/i })).toBeTruthy();
    });
  });

  it("shows calibration result containing the utilization % after calibrating", async () => {
    vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(client.saveSettings).mockResolvedValue(mockSettings());
    vi.mocked(client.calibrateLimitApi).mockResolvedValue(mockCalibrateLimit());

    const { container } = render(<SettingsPage />);
    await waitFor(() => screen.getByRole("button", { name: /Calibrate from usage/i }));

    fireEvent.click(screen.getByRole("button", { name: /Calibrate from usage/i }));

    await waitFor(() => {
      // mockCalibrateLimit provenance: "calibrated YYYY-MM-DD @ 25.0%"
      const result = container.querySelector(".settings-calibrate-result");
      expect(result).not.toBeNull();
      expect(result?.textContent).toMatch(/25\.0%/);
    });
  });

  it("shows calibration error inline when calibrateLimitApi returns ok:false", async () => {
    vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(client.calibrateLimitApi).mockResolvedValue({
      ...mockCalibrateLimit(),
      data: { ok: false, reason: "Utilization is only 3.0% — use Claude Code for a while." },
    });

    const { container } = render(<SettingsPage />);
    await waitFor(() => screen.getByRole("button", { name: /Calibrate from usage/i }));

    fireEvent.click(screen.getByRole("button", { name: /Calibrate from usage/i }));

    await waitFor(() => {
      const errEl = container.querySelector(".settings-inline-error");
      expect(errEl).not.toBeNull();
      expect(errEl?.textContent).toMatch(/utilization/i);
    });
  });
});

describe("Settings section navigation", () => {
  afterEach(() => {
    window.location.hash = "";
  });
  it("keeps unsaved form state while section navigation focuses targets and opens Advanced", async () => {
    window.location.hash = "#/settings?section=scan-roots";
    setupSuccess();
    render(<SettingsPage />);
    await waitFor(() => expect(document.activeElement?.id).toBe("scan-roots"));

    const scanRoots = screen.getByLabelText(/Scan roots/i) as HTMLTextAreaElement;
    fireEvent.change(scanRoots, { target: { value: "/unsaved/project" } });
    fireEvent.click(screen.getByRole("link", { name: "In-session guards" }));
    await waitFor(() => expect(document.activeElement?.id).toBe("settings-in-session-guards"));
    expect(scanRoots.value).toBe("/unsaved/project");

    window.location.hash = "#/settings?section=parser-health";
    fireEvent(window, new HashChangeEvent("hashchange"));
    await waitFor(() => expect(document.activeElement?.id).toBe("settings-parser-health"));
    expect(document.querySelector<HTMLDetailsElement>("#settings-advanced details")?.open).toBe(
      true,
    );

    window.location.hash = "#/settings?section=unknown";
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(document.activeElement?.id).toBe("settings-parser-health");
  });
});
