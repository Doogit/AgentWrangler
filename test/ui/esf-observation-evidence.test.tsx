import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EsfObservationCohort } from "../../src/query/api/esf-observations";

vi.mock("../../src/ui/api/esf-client", () => ({
  fetchEsfObservations: vi.fn(),
  fetchSessionEsfObservations: vi.fn(),
}));

import { fetchEsfObservations } from "../../src/ui/api/esf-client";
import { ObservationEvidence } from "../../src/ui/esf/ObservationEvidence";
import WorkspaceDetailPage from "../../src/ui/workspaces/WorkspaceDetailPage";

function cohortFor(preset: string): EsfObservationCohort {
  const window =
    preset === "24h"
      ? { from: "2026-08-23T00:00:00.000Z", to: "2026-08-24T00:00:00.000Z" }
      : preset === "prior24h"
        ? { from: "2026-08-22T00:00:00.000Z", to: "2026-08-23T00:00:00.000Z" }
        : preset === "prior7d"
          ? { from: "2026-08-10T00:00:00.000Z", to: "2026-08-17T00:00:00.000Z" }
          : { from: "2026-08-17T00:00:00.000Z", to: "2026-08-24T00:00:00.000Z" };
  return {
    cohort_definition_version: "esf-cohort-1",
    workspace_id: "ws-alpha",
    from: window.from,
    to: window.to,
    resource: {
      selected_session_count: 21,
      priced_cost_u: 860000,
      priced_turn_count: 19,
      unpriced_turn_count: 2,
      unpriced_session_count: 2,
      reconciled_priced_session_count: 16,
      live_priced_session_count: 3,
    },
    no_commit_activity: {
      session_ids: ["ses-a07"],
      session_count: 1,
      live_session_excluded_count: 3,
    },
    observed_test_recovery: {
      method_version: "esf-observed-test-recovery-1",
      affected_session_ids: ["ses-a01", "ses-a02", "ses-a03", "ses-a04", "ses-a05", "ses-a06"],
      recovered_session_ids: ["ses-a01", "ses-a02", "ses-a03"],
      eligible_reconciled_qualifying_tool_session_count: 18,
    },
    allocation_sessions: [
      {
        session_id: "ses-a01",
        priced_cost_u: 120000,
        priced_turn_count: 3,
        unpriced_turn_count: 1,
        cost_claim_counts: [],
        parser_version_counts: [],
      },
    ],
    watermark: {
      version: "esf-cohort-watermark-1",
      source_fingerprint: "fixture",
      selected_turn_count: 21,
      selected_session_count: 21,
      nonprovisional_turn_count: 21,
      latest_selected_turn_at: new Date(Date.parse(window.to) - 60 * 60 * 1000).toISOString(),
      cost_claim_counts: [],
      parser_version_counts: [],
    },
  };
}

describe("ESF observation evidence", () => {
  beforeEach(() => {
    vi.mocked(fetchEsfObservations).mockReset();
  });
  afterEach(cleanup);

  it("renders resource and recovery observations with their cohort limits", async () => {
    const prior = cohortFor("prior7d");
    prior.observed_test_recovery.affected_session_ids.push("ses-a07");
    prior.observed_test_recovery.eligible_reconciled_qualifying_tool_session_count = 103;
    vi.mocked(fetchEsfObservations)
      .mockResolvedValueOnce({ data: cohortFor("7d") } as never)
      .mockResolvedValueOnce({ data: prior } as never);
    render(
      <ObservationEvidence
        workspaceId="ws-alpha"
        filter={{ preset: "7d" }}
        title="Evidence by cohort"
      />,
    );
    expect(
      await screen.findByText(/6\/18 repeated test-failure sessions · prior 7\/103/),
    ).toBeTruthy();
    expect(
      screen.getByText(/\$0\.86 priced · 19 priced turns · prior \$0\.86 priced/),
    ).toBeTruthy();
    const launcher = screen.getByRole("button", { name: "View evidence and limits" });
    expect(screen.getByText(/This workspace includes data for last 7 days/)).toBeTruthy();
    fireEvent.click(launcher);
    const heading = await screen.findByRole("heading", { name: "Evidence and limits" });
    expect(document.activeElement).toBe(heading);
    fireEvent.click(screen.getByRole("button", { name: "View sessions (6) →" }));
    expect(screen.getByText("$0.12 · 3 priced turns · 1 unpriced turns")).toBeTruthy();
    expect(screen.getAllByRole("status", { name: "UNKNOWN" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("columnheader", { name: "Last active" })).toBeNull();
    expect(screen.queryByTitle("2026-08-23T23:00:00.000Z")).toBeNull();
    fireEvent.click(launcher);
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Evidence and limits" })).toBeNull(),
    );
    expect(document.activeElement).toBe(launcher);
    fireEvent.click(launcher);
    const reopenedHeading = await screen.findByRole("heading", { name: "Evidence and limits" });
    fireEvent.keyDown(reopenedHeading, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Evidence and limits" })).toBeNull(),
    );
    expect(document.activeElement).toBe(launcher);
  });

  it("renders the workspace's newly selected window rather than retaining a seven-day cohort", async () => {
    vi.mocked(fetchEsfObservations).mockImplementation(
      async (_workspaceId, filter) =>
        ({
          data: cohortFor(
            Date.parse(filter.to ?? "") - Date.parse(filter.from ?? "") === 86400000 ? "24h" : "7d",
          ),
        }) as never,
    );
    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);
    expect(await screen.findByText(/This workspace includes data for last 7 days/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "24h" }));
    expect(await screen.findByText(/This workspace includes data for last 24 hours/)).toBeTruthy();
    expect(vi.mocked(fetchEsfObservations).mock.calls.map(([, filter]) => filter)).toContainEqual({
      from: "2026-08-23T00:00:00.000Z",
      to: "2026-08-24T00:00:00.000Z",
    });
  });

  it("ignores an older cohort response after the window changes", async () => {
    let resolveOld!: (value: never) => void;
    vi.mocked(fetchEsfObservations)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue({ data: cohortFor("24h") } as never);
    const view = render(<ObservationEvidence workspaceId="ws-alpha" filter={{ preset: "7d" }} />);
    view.rerender(<ObservationEvidence workspaceId="ws-alpha" filter={{ preset: "24h" }} />);
    expect(await screen.findByText(/This workspace includes data for last 24 hours/)).toBeTruthy();
    await act(async () => {
      resolveOld({ data: cohortFor("7d") } as never);
    });
    expect(screen.queryByText(/This workspace includes data for last 7 days/)).toBeNull();
    expect(screen.getByText(/This workspace includes data for last 24 hours/)).toBeTruthy();
  });

  it("withholds a mismatched prior-window comparison and explains why", async () => {
    const prior = cohortFor("prior7d");
    prior.observed_test_recovery.method_version = "other-method" as never;
    vi.mocked(fetchEsfObservations)
      .mockResolvedValueOnce({ data: cohortFor("7d") } as never)
      .mockResolvedValueOnce({ data: prior } as never);

    render(<ObservationEvidence workspaceId="ws-alpha" filter={{ preset: "7d" }} />);

    expect(
      await screen.findByText("Prior window not comparable: test-recovery method differs."),
    ).toBeTruthy();
    expect(screen.queryByText(/prior 6\/18/)).toBeNull();
  });
});
