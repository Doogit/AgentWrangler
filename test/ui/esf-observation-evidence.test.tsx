import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EsfObservationCohort } from "../../src/query/api/esf-observations";

vi.mock("../../src/ui/api/esf-client", () => ({
  fetchEsfObservations: vi.fn(),
  fetchSessionEsfObservations: vi.fn(),
}));

import { fetchEsfObservations, fetchSessionEsfObservations } from "../../src/ui/api/esf-client";
import { mockSession } from "../../src/ui/api/fixtures";
import { ObservationEvidence, SessionObservedEvidence } from "../../src/ui/esf/ObservationEvidence";
import WorkspaceDetailPage from "../../src/ui/workspaces/WorkspaceDetailPage";

function fixtureSession(id: string) {
  const session = mockSession(id).data;
  if (session === null) throw new Error("Expected fixture session");
  return session;
}

function cohortFor(preset: string): EsfObservationCohort {
  return {
    cohort_definition_version: "esf-cohort-1",
    workspace_id: "ws-alpha",
    from: `${preset}-from`,
    to: `${preset}-to`,
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
    allocation_sessions: [],
    watermark: {
      version: "esf-cohort-watermark-1",
      source_fingerprint: "fixture",
      selected_turn_count: 21,
      selected_session_count: 21,
      nonprovisional_turn_count: 21,
      latest_selected_turn_at: "2026-08-14T00:00:00.000Z",
      cost_claim_counts: [],
      parser_version_counts: [],
    },
  };
}

describe("ESF observation evidence", () => {
  beforeEach(() => {
    vi.mocked(fetchEsfObservations).mockReset();
    vi.mocked(fetchSessionEsfObservations).mockReset();
  });
  afterEach(cleanup);

  it("renders resource and recovery observations with their cohort limits", async () => {
    vi.mocked(fetchEsfObservations).mockResolvedValue({ data: cohortFor("7d") } as never);
    render(
      <ObservationEvidence
        workspaceId="ws-alpha"
        filter={{ preset: "7d" }}
        title="Evidence by cohort"
      />,
    );
    expect(await screen.findByText("6 / 18 repeated test-failure sessions")).toBeTruthy();
    expect(screen.getByText(/\$0\.86 priced/)).toBeTruthy();
    const launcher = screen.getByRole("button", { name: "View evidence and limits" });
    expect(
      screen.getByText(/This workspace includes data from 7d-from up to, but not including, 7d-to/),
    ).toBeTruthy();
    fireEvent.click(launcher);
    const heading = await screen.findByRole("heading", { name: "Evidence and limits" });
    expect(document.activeElement).toBe(heading);
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
    expect(
      await screen.findByText(
        /This workspace includes data from 7d-from up to, but not including, 7d-to/,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "24h" }));
    expect(
      await screen.findByText(
        /This workspace includes data from 24h-from up to, but not including, 24h-to/,
      ),
    ).toBeTruthy();
    expect(vi.mocked(fetchEsfObservations).mock.lastCall?.[1]).toEqual({
      from: "2026-08-23T00:00:00.000Z",
      to: "2026-08-24T00:00:00.000Z",
    });
  });

  it("shows the complete server aggregate when the loaded timeline page has no unpriced turns", async () => {
    const evidence = cohortFor("session");
    evidence.resource.unpriced_turn_count = 3;
    evidence.observed_test_recovery.affected_session_ids = ["ses-a01"];
    evidence.observed_test_recovery.recovered_session_ids = [];
    vi.mocked(fetchSessionEsfObservations).mockResolvedValue({ data: evidence } as never);
    const session = {
      ...fixtureSession("ses-a01"),
      session_id: "ses-a01",
      state: "RECONCILED" as const,
      test_fail_count: 0,
    };
    render(<SessionObservedEvidence session={session} />);
    expect(await screen.findByText(/\$.* priced; 3 unpriced turns/)).toBeTruthy();
    expect(screen.getByText("repeated test failures observed")).toBeTruthy();
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
      .mockResolvedValueOnce({ data: cohortFor("24h") } as never);
    const view = render(<ObservationEvidence workspaceId="ws-alpha" filter={{ preset: "7d" }} />);
    view.rerender(<ObservationEvidence workspaceId="ws-alpha" filter={{ preset: "24h" }} />);
    expect(
      await screen.findByText(
        /This workspace includes data from 24h-from up to, but not including, 24h-to/,
      ),
    ).toBeTruthy();
    await act(async () => {
      resolveOld({ data: cohortFor("7d") } as never);
    });
    expect(
      screen.queryByText(
        /This workspace includes data from 7d-from up to, but not including, 7d-to/,
      ),
    ).toBeNull();
    expect(
      screen.getByText(
        /This workspace includes data from 24h-from up to, but not including, 24h-to/,
      ),
    ).toBeTruthy();
  });

  it("clears a previous session's counts and distinguishes loading, failure and retry", async () => {
    vi.mocked(fetchSessionEsfObservations)
      .mockResolvedValueOnce({ data: cohortFor("first") } as never)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        data: {
          ...cohortFor("next"),
          resource: { ...cohortFor("next").resource, unpriced_turn_count: 5 },
        },
      } as never);
    const first = { ...fixtureSession("first"), session_id: "first" };
    const view = render(<SessionObservedEvidence session={first} />);
    expect(screen.getByText("Loading session observations…")).toBeTruthy();
    expect(await screen.findByText(/priced; 2 unpriced turns/)).toBeTruthy();
    view.rerender(<SessionObservedEvidence session={{ ...first, session_id: "next" }} />);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("request failed"),
    );
    expect(screen.queryByText(/priced; 2 unpriced turns/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/priced; 5 unpriced turns/)).toBeTruthy();
  });
});
