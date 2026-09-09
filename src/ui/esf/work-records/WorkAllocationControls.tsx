import { useEffect, useRef, useState } from "react";
import type { AllocationSummary } from "../../../work-records/types";
import type { WorkResponse } from "../../api/work-records-client";
import { getWorkAllocation, prepareWorkAllocation } from "../../api/work-records-client";
import { errorMessage, useWorkOperation } from "./operations";

export interface WorkAllocationControlsProps {
  workspaceId: string;
  from: string;
  to: string;
  onMutationComplete?: (() => void) | undefined;
}
export function WorkAllocationControls(props: WorkAllocationControlsProps) {
  return (
    <AllocationScope key={JSON.stringify([props.workspaceId, props.from, props.to])} {...props} />
  );
}
function AllocationScope({
  workspaceId,
  from,
  to,
  onMutationComplete,
}: WorkAllocationControlsProps) {
  const [report, setReport] = useState<WorkResponse<AllocationSummary> | null>(null);
  const [readId, setReadId] = useState("");
  const [readError, setReadError] = useState<unknown>(null);
  const [reading, setReading] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const operation = useWorkOperation(() => {
    onMutationComplete?.();
  });
  const validWindow =
    Number.isFinite(Date.parse(from)) &&
    Number.isFinite(Date.parse(to)) &&
    Date.parse(from) < Date.parse(to) &&
    Date.parse(to) <= Date.now();
  async function read() {
    const requestGeneration = ++generation.current;
    setReading(true);
    setReadError(null);
    try {
      const result = await getWorkAllocation(readId.trim());
      if (
        result.data.workspace_id !== workspaceId ||
        Date.parse(result.data.cohort_from) !== Date.parse(from) ||
        Date.parse(result.data.cohort_to) !== Date.parse(to)
      )
        throw new Error("scope mismatch");
      if (requestGeneration === generation.current) setReport(result);
    } catch (error) {
      if (requestGeneration === generation.current) {
        setReport(null);
        setReadError(error);
      }
    } finally {
      if (requestGeneration === generation.current) setReading(false);
    }
  }
  return (
    <section className="work-record-allocation" aria-label="Work allocation">
      <h4>Frozen work allocation</h4>
      <p>
        Workspace {workspaceId} · [{from}, {to}). Recompute explicitly to capture current evidence;
        saved reports do not follow later membership or pricing changes.
      </p>
      {!validWindow && <p>Allocation unavailable: choose a valid completed half-open cohort.</p>}
      <button
        className="btn-secondary"
        type="button"
        disabled={!validWindow || operation.locked || reading}
        onClick={() => {
          setReadError(null);
          operation.start(
            prepareWorkAllocation(
              workspaceId,
              new Date(from).toISOString(),
              new Date(to).toISOString(),
            ),
            (result) => {
              setReport({ ...result, data: result.data.allocation });
              setReadId(result.data.allocation.allocation_revision_id);
            },
          );
        }}
      >
        Recompute allocation
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void read();
        }}
      >
        <label>
          Frozen report ID
          <input
            value={readId}
            onChange={(event) => setReadId(event.target.value)}
            disabled={reading || operation.locked}
          />
        </label>
        <button
          className="btn-secondary"
          type="submit"
          disabled={!readId.trim() || reading || operation.locked}
        >
          Read frozen report
        </button>
      </form>
      {operation.busy && <output>Recomputing allocation…</output>}
      {operation.notice}
      {reading && <output>Loading frozen report…</output>}
      {readError !== null && (
        <div role="alert">
          <p>
            {errorMessage(readError)} Only reports matching this workspace and cohort can be shown.
          </p>
          <button
            className="btn-secondary"
            type="button"
            disabled={reading}
            onClick={() => void read()}
          >
            Retry frozen report
          </button>
        </div>
      )}
      {report === null && !reading && readError === null && (
        <p>No frozen report selected. Coverage is unknown until a report is computed or read.</p>
      )}
      {report !== null && !reading && <WorkAllocationReport report={report} />}
    </section>
  );
}

export function WorkAllocationReport({ report }: { report: WorkResponse<AllocationSummary> }) {
  const data = report.data;
  const qualification = report.meta.qualification;
  return (
    <div>
      <h5>Report {data.allocation_revision_id}</h5>
      <p>
        Workspace {data.workspace_id} · [{data.cohort_from}, {data.cohort_to}) · Evidence as of{" "}
        {data.evidence_as_of}
      </p>
      <p>
        Status: {data.report_status} · Claim: {report.meta.claim_kind} · Definition:{" "}
        {report.meta.metric_definition_version}
      </p>
      <p>
        Feedback coverage: {data.feedback_coverage.numerator} / {data.feedback_coverage.denominator}
        {data.feedback_coverage.value === null && " · unknown (no eligible denominator)"}. Terminal
        reported records: {data.reported_terminal_records}.
      </p>
      <p>
        Allocation coverage (sessions): {data.allocation_session_coverage.numerator} /{" "}
        {data.allocation_session_coverage.denominator}
        {data.allocation_session_coverage.value === null && " · unknown (no eligible denominator)"}.
      </p>
      <p>
        Allocation coverage (priced cost, micro-USD): {data.allocation_cost_coverage.numerator_u} /{" "}
        {data.allocation_cost_coverage.denominator_u}
        {data.allocation_cost_coverage.value === null && " · unknown (no priced denominator)"}.
      </p>
      <p>
        Pricing coverage: {data.priced_turn_count} priced turns; {data.unpriced_turn_count} unpriced
        turns in {data.unpriced_session_count} sessions. Unpriced cost is unknown, never free.
      </p>
      <p>
        Priced cost (micro-USD): {data.eligible_priced_cost_u} eligible;{" "}
        {data.allocated_priced_cost_u} allocated; {data.unallocated_priced_cost_u} unallocated.
      </p>
      <p>
        Unallocated sessions: {data.unallocated_ungrouped_count} ungrouped;{" "}
        {data.unallocated_shared_count} shared. Archived records: {data.archived_count}. Deleted
        sources: {data.source_deleted_count}.
      </p>
      <ul>
        {Object.entries(data.outcome_counts).map(([outcome, count]) => (
          <li key={outcome}>
            {outcome}: {count}
          </li>
        ))}
      </ul>
      <p>
        Useful work (reported): {data.useful_work_rate.numerator} /{" "}
        {data.useful_work_rate.denominator} terminal records ·{" "}
        {data.useful_work_rate.value === null
          ? "unknown (no reported terminal records)"
          : `${(data.useful_work_rate.value * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`}
        . Only USEFUL, PARTIAL, UNSUCCESSFUL and ABANDONED enter this denominator. This is reported
        feedback, not an agent success rate.
      </p>
      <p>
        Terminal attempt cost (priced micro-USD): {data.terminal_attempt_priced_cost_u}. Includes
        allocated priced cost for all reported terminal outcomes; unpriced and unallocated cost
        remain outside this subtotal.
      </p>
      <p>
        Cost per useful record (priced micro-USD):{" "}
        {data.cost_per_useful_u ??
          `unavailable (${data.cost_per_useful_unavailable_reason ?? "unknown"})`}
        .
      </p>
      <p>
        Frozen qualifications: provisional excluded {String(qualification.provisional_excluded)};{" "}
        {qualification.unpriced_turns} unpriced turns; {qualification.claim_kinds_count} pricing
        claim kinds. {qualification.note}
      </p>
      <p>
        Historical deletion can make this report partial or source-deleted. It cannot reconstruct
        removed feedback or evidence. No success is inferred from activity.
      </p>
      <details>
        <summary>Session allocation and source limits</summary>
        {data.sessions.length === 0 ? (
          <p>No eligible sessions in this frozen cohort.</p>
        ) : (
          <ul>
            {data.sessions.map((session) => (
              <li key={session.session_id}>
                {session.session_id}: {session.disposition} · Owner{" "}
                {session.owner_snapshot_id ?? "unallocated"} · {session.priced_turn_count} priced /{" "}
                {session.unpriced_turn_count} unpriced turns
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
