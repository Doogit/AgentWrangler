/**
 * test/ui/workspaces.test.tsx — Workspaces UI: component-level and page tests.
 *
 * RV1a restructured WorkspacesPage to lead with a spend table; the methodology
 * disclosure banner and context-workspace select were intentionally removed per
 * spec (no banner above the table; context composition moved to WorkspaceDetailPage).
 * Tests updated to match the new structure.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextComposition } from "../../src/query/api/context-composition";
import * as client from "../../src/ui/api/client";
import {
  mockContextComposition,
  mockLinkageRate,
  mockSuccessRate,
  mockTrends,
  mockWorkspaceOutcomes,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import ContextCompositionPanel from "../../src/ui/workspaces/ContextCompositionPanel";
import LinkageBanner from "../../src/ui/workspaces/LinkageBanner";
import OutcomeSummaryCard from "../../src/ui/workspaces/OutcomeSummaryCard";
import WorkspaceOutcomeTable from "../../src/ui/workspaces/WorkspaceOutcomeTable";
import WorkspacesPage from "../../src/ui/workspaces/WorkspacesPage";

vi.mock("../../src/ui/api/client");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Default mock setup for all WorkspacesPage calls
function setupWorkspacesPageMocks() {
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  vi.mocked(client.fetchTrends).mockResolvedValue(mockTrends({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaceOutcomes).mockResolvedValue(mockWorkspaceOutcomes());
}

// ---------------------------------------------------------------------------
// OutcomeSummaryCard
// ---------------------------------------------------------------------------

describe("OutcomeSummaryCard", () => {
  it("shows N/A and EXPERIMENTAL chip when data is null (token unset)", () => {
    render(<OutcomeSummaryCard data={null} />);
    expect(screen.getAllByText("N/A").length).toBeGreaterThan(0);
    expect(screen.getByRole("status", { name: "EXPERIMENTAL" })).toBeTruthy();
  });

  it("shows success rate and EXPERIMENTAL chip with real data", () => {
    render(
      <OutcomeSummaryCard
        data={{
          terminal_n: 10,
          success_rate: 0.8,
          clean_success_n: 6,
          with_deferrals_n: 2,
          no_ci_success_n: 0,
          linkage_rate: 0.62,
          methodology_note: "73% (validation corpus): ...",
        }}
      />,
    );
    expect(screen.getByText("80.0%")).toBeTruthy();
    expect(screen.getByRole("status", { name: "EXPERIMENTAL" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// WorkspaceOutcomeTable
// ---------------------------------------------------------------------------

describe("WorkspaceOutcomeTable", () => {
  it("shows EXPERIMENTAL chip on table header", () => {
    render(<WorkspaceOutcomeTable rows={[]} />);
    expect(screen.getByRole("status", { name: "EXPERIMENTAL" })).toBeTruthy();
  });

  it("shows empty state banner when rows is null", () => {
    render(<WorkspaceOutcomeTable rows={null} />);
    // Should show empty-state message
    expect(screen.getByText(/No linked work items/i)).toBeTruthy();
  });

  it("renders per-workspace rows", () => {
    render(
      <WorkspaceOutcomeTable
        rows={[
          {
            workspace_id: "ws-1",
            project_slug: "MyProject",
            total_n: 5,
            in_progress_n: 1,
            terminal_n: 4,
            success_n: 3,
            failure_n: 1,
            success_rate: 0.75,
            linkage_rate: 0.6,
            adherence_score: 80,
          },
        ]}
      />,
    );
    expect(screen.getByText("MyProject")).toBeTruthy();
    expect(screen.getByText("75.0%")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Routing proxy" })).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy();
  });

  it("formats 0, 100, mixed, and no-turn routing proxy scores as 0-100 values", () => {
    const base = {
      total_n: 0,
      in_progress_n: 0,
      terminal_n: 0,
      success_n: 0,
      failure_n: 0,
      success_rate: null,
      linkage_rate: null,
    };
    render(
      <WorkspaceOutcomeTable
        rows={[
          { ...base, workspace_id: "ws-zero", project_slug: "Zero", adherence_score: 0 },
          { ...base, workspace_id: "ws-full", project_slug: "Full", adherence_score: 100 },
          { ...base, workspace_id: "ws-mixed", project_slug: "Mixed", adherence_score: 50 },
          { ...base, workspace_id: "ws-empty", project_slug: "Empty", adherence_score: null },
        ]}
      />,
    );

    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// LinkageBanner
// ---------------------------------------------------------------------------

describe("LinkageBanner", () => {
  it("shows EXPERIMENTAL chip and N/A message when data is null", () => {
    render(<LinkageBanner data={null} />);
    expect(screen.getByRole("status", { name: "EXPERIMENTAL" })).toBeTruthy();
    expect(screen.getByText(/configure a GitHub token/i)).toBeTruthy();
  });

  it("shows live linkage rate when data is provided", () => {
    render(
      <LinkageBanner
        data={{
          linkage_rate: 0.72,
          denominator_n: 25,
          methodology_note: "...",
        }}
      />,
    );
    expect(screen.getByText("72.0%")).toBeTruthy();
  });

  it("offers the RI10 commit-trailer hook without leaking the session URL", () => {
    const { container } = render(<LinkageBanner data={null} />);
    expect(screen.getByText(/install the commit-trailer hook/i)).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).toContain("Agent-Session-Id:");
    expect(text).not.toContain("claude.ai");
  });
});

describe("ContextCompositionPanel", () => {
  it("renders the required residual label", () => {
    render(
      <ContextCompositionPanel
        data={{
          workspace_id: "ws-1",
          observed_context_tokens: 10_000,
          observed_turns: 2,
          inventory_rows: 1,
          rows: [
            { key: "always_loaded", label: "always loaded", tokens: 2_000, share: 0.2 },
            {
              key: "session_residual",
              label: "session history + tool outputs (not itemized in v1)",
              tokens: 8_000,
              share: 0.8,
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Session history + tools")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// WorkspacesPage (RV1a) — spend table
// ---------------------------------------------------------------------------

describe("WorkspacesPage — RV1a spend table", () => {
  beforeEach(() => {
    setupWorkspacesPageMocks();
  });

  it("renders the expected table columns", async () => {
    render(<WorkspacesPage />);
    await waitFor(() => {
      expect(screen.getByRole("columnheader", { name: "Workspace" })).toBeTruthy();
    });
    expect(screen.getByRole("columnheader", { name: "Spend" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Share" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Trend" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Ctx/turn" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Cache-write %" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Opus %" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "$/turn" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Success" })).toBeTruthy();
  });

  it("renders workspace rows from the workspaces fixture", async () => {
    render(<WorkspacesPage />);
    // orbit-api appears as acme/orbit-api via workspaceLabel
    await waitFor(() => {
      expect(screen.getByText(/acme\/orbit-api/)).toBeTruthy();
    });
  });

  it("hides transient workspaces by default and shows them when toggled", async () => {
    const workspaces = mockWorkspaces({ preset: "7d" });
    if (workspaces.data === null) throw new Error("workspace fixture must contain data");
    workspaces.data.items = [
      {
        ...workspaces.data.items[0],
        workspace_id: "C--Users-x-repo",
        project_slug: "raw-mapped",
        repo_owner: "acme",
        repo_name: "console",
      },
      {
        ...workspaces.data.items[1],
        workspace_id: "transient-id",
        project_slug: "raw-transient",
        repo_path: null,
        repo_owner: null,
        repo_name: null,
      },
      {
        ...workspaces.data.items[2],
        workspace_id: "__global__",
        project_slug: "raw-global",
        repo_path: null,
        repo_owner: null,
        repo_name: null,
      },
    ] as unknown as typeof workspaces.data.items;
    vi.mocked(client.fetchWorkspaces).mockResolvedValue(workspaces);

    render(<WorkspacesPage />);

    // Mapped workspace visible
    await waitFor(() => {
      expect(screen.getByText("acme/console")).toBeTruthy();
    });

    // Transient + global hidden by default
    expect(screen.queryByText("transient-id")).toBeNull();
    expect(screen.queryByText("Global")).toBeNull();

    // Toggle on
    fireEvent.click(screen.getByRole("checkbox", { name: /show transient workspaces/i }));
    await waitFor(() => {
      expect(screen.getByText("transient-id")).toBeTruthy();
    });
    expect(screen.getByText("Global")).toBeTruthy();
  });

  it("shows empty state when no workspaces", async () => {
    const empty = mockWorkspaces({ preset: "7d" });
    if (empty.data === null) throw new Error("fixture must have data");
    empty.data.items = [];
    vi.mocked(client.fetchWorkspaces).mockResolvedValue(empty);

    render(<WorkspacesPage />);
    await waitFor(() => {
      expect(screen.getByText(/No workspaces yet/i)).toBeTruthy();
    });
  });

  it("navigates to workspace detail on row click", async () => {
    render(<WorkspacesPage />);
    await waitFor(() => {
      expect(screen.getByText(/acme\/orbit-api/)).toBeTruthy();
    });
    const row = screen.getByText(/acme\/orbit-api/).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row as Element);
    await waitFor(() => {
      expect(window.location.hash).toBe("#/workspaces/ws-1");
    });
  });
});

// ---------------------------------------------------------------------------
// No SQL in workspaces UI files (structural guard)
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

describe("no SQL in workspaces UI files", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const WS_ROOT = path.resolve(__dirname, "../../src/ui/workspaces");

  it("workspaces files contain no SQL or SQLite imports", () => {
    const files = fs.readdirSync(WS_ROOT).filter((f) => /\.(ts|tsx)$/.test(f));
    const SELECT_FROM = /\bSELECT\b[\s\S]*?\bFROM\b/i;
    const SQLITE_IMPORT = /(?:from|require\(\s*)["'][^"']*better-sqlite3/;
    const violations: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(path.join(WS_ROOT, file), "utf-8");
      if (SELECT_FROM.test(src)) violations.push(`${file}: SELECT…FROM`);
      if (SQLITE_IMPORT.test(src)) violations.push(`${file}: better-sqlite3 import`);
    }
    expect(violations).toEqual([]);
  });
});
