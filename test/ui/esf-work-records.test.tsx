import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildResponse } from "../../src/query/envelope";
import {
  prepareCreateWorkRecord,
  prepareWorkRecordAction,
} from "../../src/ui/api/work-records-client";
import { WorkRecordControls } from "../../src/ui/esf/work-records/WorkRecordControls";
import type { AllocationSummary, WorkRecordView } from "../../src/work-records/types";

const from = "2026-09-01T00:00:00.000Z";
const to = "2026-09-02T00:00:00.000Z";
const record = (): WorkRecordView => ({
  work_record_id: "record-1",
  workspace_id: "ws",
  created_at: from,
  updated_at: from,
  current_revision_no: 0,
  archived_at: null,
  external_ref_id: null,
  external_ref_kind: null,
  current: {
    revision_no: 0,
    task_intent: "DEBUG",
    outcome_state: "ACTIVE",
    repair_band: "UNREPORTED",
    effort_band: "UNREPORTED",
    feedback_source: "NONE",
    reported_at: null,
    recorded_at: from,
    mutation_id: "record-1",
  },
  session_links: [],
  context_refs: [],
});
const allocation = (): AllocationSummary => ({
  allocation_revision_id: "allocation-1",
  workspace_id: "ws",
  cohort_from: from,
  cohort_to: to,
  evidence_as_of: to,
  report_status: "PARTIAL",
  eligible_session_count: 1,
  allocated_session_count: 0,
  unallocated_ungrouped_count: 1,
  unallocated_shared_count: 0,
  eligible_priced_cost_u: 12,
  allocated_priced_cost_u: 0,
  unallocated_priced_cost_u: 12,
  priced_turn_count: 1,
  unpriced_turn_count: 2,
  unpriced_session_count: 1,
  records_total: 1,
  records_with_feedback: 0,
  reported_terminal_records: 0,
  outcome_counts: {
    ACTIVE: 0,
    USEFUL: 0,
    PARTIAL: 0,
    UNSUCCESSFUL: 0,
    ABANDONED: 0,
    UNKNOWN: 0,
    UNREPORTED: 1,
  },
  archived_count: 0,
  source_deleted_count: 1,
  useful_work_rate: { numerator: 0, denominator: 0, value: null },
  feedback_coverage: { numerator: 0, denominator: 1, value: 0 },
  allocation_session_coverage: { numerator: 0, denominator: 1, value: 0 },
  allocation_cost_coverage: { numerator_u: 0, denominator_u: 12, value: 0 },
  terminal_attempt_priced_cost_u: 0,
  cost_per_useful_u: null,
  cost_per_useful_unavailable_reason: "INCOMPLETE_COST_COVERAGE",
  sessions: [],
});
const envelope = <T,>(data: T) =>
  buildResponse(data, {
    claim_kind: "EXPERIMENTAL",
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 2,
      claim_kinds_count: 2,
      note: "Frozen pricing qualification.",
    },
  });
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
let rows: WorkRecordView[];
let calls: Array<{ path: string; init: RequestInit; body: Record<string, unknown> }>;
let failWrite: "network" | "conflict" | null;
let issued: number;
let frozen: AllocationSummary;
beforeEach(() => {
  rows = [];
  calls = [];
  failWrite = null;
  issued = 0;
  frozen = allocation();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ path, init, body });
      if (path === "/api/token") return response({ token: `token-${calls.length}` });
      if (path.endsWith("/ids"))
        return response(envelope({ id: `issued-${++issued}`, expires_at: to }));
      if (init.method === "POST" || init.method === "DELETE") {
        if (failWrite === "network") {
          failWrite = null;
          throw new TypeError("network");
        }
        if (failWrite === "conflict") {
          failWrite = null;
          return response({ code: "REVISION_CONFLICT" }, 409);
        }
        if (path.endsWith("/recompute")) {
          frozen.allocation_revision_id = String(body.allocation_revision_id);
          return response(envelope({ allocation: frozen, replayed: false }));
        }
        if (path.endsWith("/delete")) {
          rows = [];
          return response(
            envelope({
              work_record_id: "record-1",
              deleted_at: to,
              delete_mutation_id: body.mutation_id,
              replayed: false,
            }),
          );
        }
        const row = rows[0] ?? record();
        if (path === "/api/work-records") {
          row.work_record_id = String(body.work_record_id);
          row.current.task_intent = body.task_intent as "DEBUG";
        } else {
          row.current_revision_no++;
        }
        if (path.endsWith("/archive")) row.archived_at = to;
        if (path.endsWith("/reopen")) row.archived_at = null;
        if (path.endsWith("/edit") || path.endsWith("/closeout"))
          Object.assign(row.current, body, {
            feedback_source: path.endsWith("/edit") ? "USER_EDIT" : "USER_CLOSEOUT",
            reported_at: to,
          });
        if (path.endsWith("/sessions"))
          row.session_links.push({
            session_id: String(body.session_id),
            linked_at: from,
            linked_revision_no: row.current_revision_no,
            unlinked_at: null,
            unlinked_revision_no: null,
          });
        if (path.includes("/sessions/") && path.endsWith("/detach")) {
          const link = row.session_links[0];
          if (link) link.unlinked_at = to;
        }
        if (path.endsWith("/contexts"))
          row.context_refs.push({
            context_kind: "WORKTREE",
            context_ref_id: String(body.context_ref_id),
            linked_at: from,
            linked_revision_no: row.current_revision_no,
            unlinked_at: null,
            unlinked_revision_no: null,
          });
        if (path.includes("/contexts/") && path.endsWith("/detach")) {
          const context = row.context_refs[0];
          if (context) context.unlinked_at = to;
        }
        rows = [row];
        return response(envelope({ record: row, replayed: false }));
      }
      if (path.includes("/allocations/")) return response(envelope(frozen));
      return response(envelope(rows));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const mount = (onMutationComplete: () => void = vi.fn()) =>
  render(
    <WorkRecordControls
      workspaceId="ws"
      sessionId="session-1"
      from={from}
      to={to}
      onMutationComplete={onMutationComplete}
    />,
  );
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const writes = () =>
  calls.filter(
    (call) =>
      (call.init.method === "POST" || call.init.method === "DELETE") && !call.path.endsWith("/ids"),
  );
async function selectRecord() {
  rows = [record()];
  mount();
  click(await screen.findByRole("button", { name: "record-1" }).then(() => "record-1"));
  await screen.findByRole("heading", { name: "Work record record-1" });
}

describe("standalone work-record controls", () => {
  it("uses fresh tokens for issuance and writes, retaining the exact create request on retry", async () => {
    mount();
    await screen.findByText("No local work records.");
    fireEvent.change(screen.getByLabelText("Task intent"), { target: { value: "DEBUG" } });
    failWrite = "network";
    click("Create work record");
    await screen.findByRole("button", { name: "Retry same request" });
    expect(
      (screen.getByLabelText("Task intent") as HTMLSelectElement).closest("fieldset")?.disabled,
    ).toBe(true);
    click("Retry same request");
    await screen.findByRole("heading", { name: "Work record issued-1" });
    expect(writes()).toHaveLength(2);
    expect(writes()[0]?.init.body).toBe(writes()[1]?.init.body);
    expect(issued).toBe(1);
    for (const call of calls.filter((call) => call.init.method === "POST"))
      expect(call.init.headers).toHaveProperty("X-AgentWrangler-Token");
    expect(writes()[0]?.init.headers).not.toEqual(writes()[1]?.init.headers);
  });
  it("snapshots edit fields before issuance and encodes membership IDs", async () => {
    const fields = {
      task_intent: "DEBUG" as const,
      outcome_state: "UNKNOWN" as const,
      repair_band: "UNREPORTED" as const,
      effort_band: "UNREPORTED" as const,
    };
    const operation = prepareWorkRecordAction("r/a", 4, { action: "edit", fields });
    Object.assign(fields, { outcome_state: "USEFUL" });
    await operation.run();
    expect(writes()[0]).toMatchObject({
      path: "/api/work-records/r%2Fa/edit",
      body: { outcome_state: "UNKNOWN", expected_revision_no: 4, feedback_source: "USER_EDIT" },
    });
    await prepareWorkRecordAction("r/a", 5, { action: "detach-session", sessionId: "s/a" }).run();
    expect(writes()[1]?.path).toBe("/api/work-records/r%2Fa/sessions/s%2Fa/detach");
  });
  it("surfaces conflicts without retrying or notifying a successful mutation", async () => {
    rows = [record()];
    const changed = vi.fn();
    mount(changed);
    await screen.findByRole("button", { name: "record-1" });
    click("record-1");
    failWrite = "conflict";
    click("Archive work record");
    await screen.findByText(/Revision conflict/);
    expect(screen.queryByRole("button", { name: "Retry same request" })).toBeNull();
    click("Reload and review");
    await screen.findByRole("button", { name: "Archive work record" });
    expect(writes()).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
  });
  it("refreshes archive/reopen, closeout and session/context intervals", async () => {
    await selectRecord();
    expect(
      (screen.getByRole("button", { name: "Close out work record" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    click("Archive work record");
    await screen.findByRole("button", { name: "Reopen work record" });
    click("Reopen work record");
    await screen.findByRole("button", { name: "Archive work record" });
    fireEvent.change(screen.getByLabelText("Reported outcome"), { target: { value: "UNKNOWN" } });
    click("Close out work record");
    await screen.findByText(/Source: USER_CLOSEOUT/);
    expect(writes().at(-1)?.body).toMatchObject({
      outcome_state: "UNKNOWN",
      repair_band: "UNREPORTED",
      effort_band: "UNREPORTED",
    });
    click("Attach session");
    await screen.findByRole("button", { name: "Detach session session-1" });
    click("Detach session session-1");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Detach session session-1" })).toBeNull(),
    );
    click("Attach WORKTREE context");
    await screen.findByRole("button", { name: /Detach context/ });
    const contextWrite = writes().at(-1);
    expect(contextWrite?.body).toHaveProperty("context_kind", "WORKTREE");
    click(/Detach context/);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Detach context/ })).toBeNull(),
    );
    expect(writes().at(-1)?.body).toHaveProperty("context_kind", "WORKTREE");
    expect(screen.getByText(/Feedback: UNKNOWN/)).toBeTruthy();
  });
  it("requires explicit delete confirmation, focuses cancel and supports Escape", async () => {
    await selectRecord();
    const launcher = screen.getByRole("button", { name: "Delete work record…" });
    launcher.focus();
    fireEvent.click(launcher);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel deletion" }));
    expect(writes()).toHaveLength(0);
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(launcher);
    fireEvent.click(launcher);
    click("Confirm permanent deletion");
    await screen.findByText("No local work records.");
    expect(writes()[0]).toMatchObject({
      init: { method: "DELETE" },
      body: { confirm: true, expected_revision_no: 0 },
    });
  });
  it("recomputes the selected cohort and reads the same frozen ID with separate qualifications", async () => {
    mount();
    click("Recompute allocation");
    await screen.findByRole("heading", { name: "Report issued-2" });
    expect(writes()[0]?.body).toMatchObject({
      workspace_id: "ws",
      cohort_from: from,
      cohort_to: to,
      allocation_revision_id: "issued-2",
    });
    expect(screen.getByText(/Feedback coverage: 0 \/ 1/)).toBeTruthy();
    expect(
      screen.getByText(/Useful work \(reported\): 0 \/ 0 terminal records/).textContent,
    ).toContain("unknown (no reported terminal records)");
    expect(screen.getByText(/Terminal attempt cost \(priced micro-USD\): 0/)).toBeTruthy();
    expect(screen.getByText(/Allocation coverage \(sessions\): 0 \/ 1/)).toBeTruthy();
    expect(screen.getByText(/Pricing coverage: 1 priced turns; 2 unpriced/)).toBeTruthy();
    expect(screen.getByText(/Frozen pricing qualification/)).toBeTruthy();
    expect(screen.getByText("UNREPORTED: 1")).toBeTruthy();
    expect(screen.getByText("UNKNOWN: 0")).toBeTruthy();
    click("Read frozen report");
    await waitFor(() =>
      expect(calls.some((call) => call.path === "/api/work-records/allocations/issued-2")).toBe(
        true,
      ),
    );
    expect(writes()).toHaveLength(1);
    await screen.findByText(/Status: PARTIAL/);
  });
  it("shows reported terminal rate and all terminal attempt cost separately from coverage", async () => {
    frozen.records_total = 4;
    frozen.records_with_feedback = 3;
    frozen.reported_terminal_records = 2;
    frozen.outcome_counts = {
      ACTIVE: 0,
      USEFUL: 1,
      PARTIAL: 1,
      UNSUCCESSFUL: 0,
      ABANDONED: 0,
      UNKNOWN: 1,
      UNREPORTED: 1,
    };
    frozen.feedback_coverage = { numerator: 3, denominator: 4, value: 0.75 };
    frozen.useful_work_rate = { numerator: 1, denominator: 2, value: 0.5 };
    frozen.allocated_session_count = 1;
    frozen.unallocated_ungrouped_count = 0;
    frozen.allocated_priced_cost_u = 12;
    frozen.unallocated_priced_cost_u = 0;
    frozen.source_deleted_count = 0;
    frozen.allocation_session_coverage = { numerator: 1, denominator: 1, value: 1 };
    frozen.allocation_cost_coverage = { numerator_u: 12, denominator_u: 12, value: 1 };
    frozen.sessions = [
      {
        session_id: "session-1",
        owner_snapshot_id: "record-1",
        disposition: "OWNED",
        priced_cost_u: 12,
        priced_turn_count: 1,
        unpriced_turn_count: 2,
      },
    ];
    frozen.terminal_attempt_priced_cost_u = 12;
    mount();
    click("Recompute allocation");
    await screen.findByRole("heading", { name: "Report issued-2" });
    expect(
      screen.getByText(/Useful work \(reported\): 1 \/ 2 terminal records/).textContent,
    ).toContain("50%");
    expect(screen.getByText(/Feedback coverage: 3 \/ 4/)).toBeTruthy();
    expect(screen.getByText(/Terminal attempt cost \(priced micro-USD\): 12/)).toBeTruthy();
    expect(screen.getByText(/Cost per useful record/).textContent).toContain(
      "unavailable (INCOMPLETE_COST_COVERAGE)",
    );
    click("Read frozen report");
    await screen.findByText(/Status: PARTIAL/);
    expect(screen.getByText(/Useful work \(reported\): 1 \/ 2 terminal records/)).toBeTruthy();
    expect(writes()).toHaveLength(1);
  });
  it("hides previous-scope evidence and distinguishes loading, unavailable and empty", async () => {
    const view = mount();
    await screen.findByText("No local work records.");
    click("Recompute allocation");
    await screen.findByRole("heading", { name: "Report issued-2" });
    vi.mocked(fetch).mockImplementation(async () => response(envelope(null)));
    view.rerender(<WorkRecordControls workspaceId="other" from={from} to={to} />);
    expect(screen.queryByRole("heading", { name: "Report issued-2" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Loading");
    await screen.findByText("Work-record evidence unavailable.");
    expect(screen.queryByText("No local work records.")).toBeNull();
  });
  it("does not send a write when token acquisition fails", async () => {
    vi.mocked(fetch).mockResolvedValue(response({}, 401));
    await expect(prepareCreateWorkRecord("ws", "UNKNOWN").run()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retries allocation with the same IDs, cohort and evidence timestamp", async () => {
    mount();
    failWrite = "network";
    click("Recompute allocation");
    await screen.findByRole("button", { name: "Retry same request" });
    click("Retry same request");
    await screen.findByRole("heading", { name: "Report issued-2" });
    expect(writes()).toHaveLength(2);
    expect(writes()[0]?.init.body).toBe(writes()[1]?.init.body);
    expect(issued).toBe(2);
  });
  it("does not retry a saved mutation when the parent refresh callback throws", async () => {
    mount(() => {
      throw new Error("parent refresh");
    });
    await screen.findByText("No local work records.");
    click("Create work record");
    await screen.findByText(/Change saved, but page evidence could not be refreshed/);
    expect(screen.queryByRole("button", { name: "Retry same request" })).toBeNull();
    expect(writes()).toHaveLength(1);
  });
  it("rejects frozen readback from a different cohort", async () => {
    frozen.cohort_to = "2026-09-03T00:00:00.000Z";
    mount();
    fireEvent.change(screen.getByLabelText("Frozen report ID"), {
      target: { value: "allocation-1" },
    });
    click("Read frozen report");
    await screen.findByText(/Only reports matching this workspace and cohort/);
    expect(screen.queryByRole("heading", { name: "Report allocation-1" })).toBeNull();
  });
});
