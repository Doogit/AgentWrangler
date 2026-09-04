/**
 * test/ui/workspaces/r4a-cost-per-success.test.tsx — R4a lifecycle cost-per-success
 * cells on WorkspaceDetailPage: populated values, null/zero honesty, coverage-gated
 * copy, the DIRECTIONAL + OBS_PROXY tier chips, and the INT-5 no-dollar-headline guard.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
import {
  mockClosureProxy,
  mockContextComposition,
  mockCostPerSuccess,
  mockWorkspaceOutcomes,
  mockWorkspaceSessions,
  mockWorkspaces,
} from "../../../src/ui/api/fixtures";
import WorkspaceDetailPage from "../../../src/ui/workspaces/WorkspaceDetailPage";

vi.mock("../../../src/ui/api/client");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const WS = "ws-1";

beforeEach(() => {
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaceSessions).mockResolvedValue(
    mockWorkspaceSessions(WS, { preset: "7d" }),
  );
  vi.mocked(client.fetchContextComposition).mockResolvedValue(mockContextComposition(WS));
  vi.mocked(client.fetchWorkspaceOutcomes).mockResolvedValue(mockWorkspaceOutcomes());
  vi.mocked(client.fetchClosureProxy).mockResolvedValue(mockClosureProxy(WS));
  vi.mocked(client.fetchCostPerSuccess).mockResolvedValue(mockCostPerSuccess({ preset: "7d" }, WS));
});

describe("R4a cost-per-success cells on WorkspaceDetailPage", () => {
  it("renders populated cost-per-success cells with exact figures", async () => {
    render(<WorkspaceDetailPage workspaceId={WS} onBack={() => {}} />);

    // Anchor on an inner cell (only present once status==='ok') so the following
    // synchronous assertions are race-free — the outer card div exists even in loading.
    await screen.findByTestId("r4a-cost-per-merged-pr");

    // Fixture: merged=8, closed=2, cost/merged=$4.25, commit-sessions=5, cost/session=$6.80,
    // coverage=42.5 -> 43%.
    expect(screen.getByTestId("r4a-cost-per-merged-pr").textContent).toBe("$4.25");
    expect(screen.getByTestId("r4a-merged-count").textContent).toBe("8");
    expect(screen.getByTestId("r4a-closed-count").textContent).toBe("2");
    expect(screen.getByTestId("r4a-cost-per-commit-session").textContent).toBe("$6.80");
    expect(screen.getByTestId("r4a-commit-session-count").textContent).toBe("5");
    expect(screen.getByTestId("r4a-linkage-coverage").textContent).toBe("43%");

    const summary = screen.getByTestId("r4a-summary");
    expect(summary.textContent).toContain("8 merged PRs");
    expect(summary.textContent).toContain("$4.25");
  });

  it("shows both the DIRECTIONAL and OBS_PROXY tier chips", async () => {
    render(<WorkspaceDetailPage workspaceId={WS} onBack={() => {}} />);

    await screen.findByTestId("r4a-cost-per-merged-pr");
    const card = screen.getByTestId("r4a-cost-per-success");
    // Assert by Chip CSS class, not label text — robust to Chip copy changes (e.g. the ±BPE suffix).
    expect(card.querySelector(".chip-directional")).toBeTruthy();
    expect(card.querySelector(".chip-obs-proxy")).toBeTruthy();
  });

  it("surfaces the coverage cap as a gated claim from linkage_coverage_pct", async () => {
    render(<WorkspaceDetailPage workspaceId={WS} onBack={() => {}} />);

    const card = await screen.findByTestId("r4a-cost-per-success");
    // Coverage-dependent claim is gated on the real coverage number (43%), not asserted blindly.
    expect(card.textContent).toContain("Only 43% of in-window sessions are linked to a PR");
    // The four caveats are carried in the copy.
    expect(card.textContent).toContain("Survivorship");
    expect(card.textContent).toContain("reviewer");
    expect(card.textContent).toContain("lifecycle attribution");
  });

  it("renders honest em-dash (never $0.00) when there are no merged PRs", async () => {
    const noMerged = mockCostPerSuccess({ preset: "7d" }, WS);
    if (noMerged.data === null) throw new Error("fixture must have data");
    noMerged.data = {
      ...noMerged.data,
      merged_pr_count: 0,
      cost_per_merged_pr_u: null,
    };
    vi.mocked(client.fetchCostPerSuccess).mockResolvedValue(noMerged);

    render(<WorkspaceDetailPage workspaceId={WS} onBack={() => {}} />);

    const cell = await screen.findByTestId("r4a-cost-per-merged-pr");
    expect(cell.textContent).toBe("— (no merged PRs yet)");
    expect(screen.getByTestId("r4a-merged-count").textContent).toBe("0");
    const summary = screen.getByTestId("r4a-summary");
    expect(summary.textContent).toContain("No merged PRs linked in this window");
    // Null honesty: never a misleading zero-dollar or NaN figure.
    expect(cell.textContent).not.toContain("$0.00");
    expect(cell.textContent).not.toContain("NaN");
  });

  it("renders '—' and an unavailable note when linkage_coverage_pct is null", async () => {
    const noCoverage = mockCostPerSuccess({ preset: "7d" }, WS);
    if (noCoverage.data === null) throw new Error("fixture must have data");
    noCoverage.data = { ...noCoverage.data, linkage_coverage_pct: null };
    vi.mocked(client.fetchCostPerSuccess).mockResolvedValue(noCoverage);

    render(<WorkspaceDetailPage workspaceId={WS} onBack={() => {}} />);

    const cell = await screen.findByTestId("r4a-linkage-coverage");
    expect(cell.textContent).toBe("—");
    const card = screen.getByTestId("r4a-cost-per-success");
    expect(card.textContent).toContain("Linkage coverage is unavailable");
    // No coverage-gated numeric claim may be asserted when coverage is null.
    expect(card.textContent).not.toContain("% of in-window sessions are linked");
  });

  it("renders '— (no commit-sessions yet)' when cost_per_commit_session_u is null", async () => {
    const noCommit = mockCostPerSuccess({ preset: "7d" }, WS);
    if (noCommit.data === null) throw new Error("fixture must have data");
    noCommit.data = {
      ...noCommit.data,
      commit_session_count: 0,
      cost_per_commit_session_u: null,
    };
    vi.mocked(client.fetchCostPerSuccess).mockResolvedValue(noCommit);

    render(<WorkspaceDetailPage workspaceId={WS} onBack={() => {}} />);

    const cell = await screen.findByTestId("r4a-cost-per-commit-session");
    expect(cell.textContent).toBe("— (no commit-sessions yet)");
    expect(screen.getByTestId("r4a-commit-session-count").textContent).toBe("0");
    // Null honesty: never a misleading zero-dollar or NaN figure.
    expect(cell.textContent).not.toContain("$0.00");
    expect(cell.textContent).not.toContain("NaN");
  });

  it("renders '0%' and the gated claim when linkage_coverage_pct is 0 (measured zero, not null)", async () => {
    const zeroCoverage = mockCostPerSuccess({ preset: "7d" }, WS);
    if (zeroCoverage.data === null) throw new Error("fixture must have data");
    zeroCoverage.data = { ...zeroCoverage.data, linkage_coverage_pct: 0 };
    vi.mocked(client.fetchCostPerSuccess).mockResolvedValue(zeroCoverage);

    render(<WorkspaceDetailPage workspaceId={WS} onBack={() => {}} />);

    const cell = await screen.findByTestId("r4a-linkage-coverage");
    // 0 is a real measured value → "0%", never "—" (which is reserved for null).
    expect(cell.textContent).toBe("0%");
    const card = screen.getByTestId("r4a-cost-per-success");
    expect(card.textContent).toContain("Only 0% of in-window sessions are linked to a PR");
    expect(card.textContent).not.toContain("Linkage coverage is unavailable");
  });

  it("renders an honest empty state (never a blank card) when the envelope data is null", async () => {
    const nullEnvelope = mockCostPerSuccess({ preset: "7d" }, WS);
    nullEnvelope.data = null;
    vi.mocked(client.fetchCostPerSuccess).mockResolvedValue(nullEnvelope);

    render(<WorkspaceDetailPage workspaceId={WS} onBack={() => {}} />);

    const empty = await screen.findByTestId("r4a-empty");
    expect(empty.textContent).toContain("No cost-per-success data");
    // The data grid must NOT render at all.
    expect(screen.queryByTestId("r4a-cost-per-merged-pr")).toBeNull();
  });

  it("never renders a $X wasted / $X saved dollar-headline (INT-5)", async () => {
    render(<WorkspaceDetailPage workspaceId={WS} onBack={() => {}} />);

    await screen.findByTestId("r4a-cost-per-merged-pr");
    const card = screen.getByTestId("r4a-cost-per-success");
    const text = (card.textContent ?? "").toLowerCase();
    expect(text).not.toMatch(/\$[\d.]+\s*wasted/);
    expect(text).not.toMatch(/\$[\d.]+\s*saved/);
  });
});
