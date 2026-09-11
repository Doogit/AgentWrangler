import { useEffect, useState } from "react";
import type { ReportedWorkSummary } from "../../query/api/reported-work";
import type { ApiResponse } from "../../query/envelope";
import { WorkRecordControls } from "./work-records/WorkRecordControls";
import "./work-records/work-records.css";

const TERMINAL_OUTCOMES = ["USEFUL", "PARTIAL", "UNSUCCESSFUL", "ABANDONED"] as const;
const OUTSIDE_TERMINAL_OUTCOMES = ["ACTIVE", "UNKNOWN", "UNREPORTED"] as const;

function focusCreateForm(event: React.MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
  document.getElementById("work-record-create")?.focus();
}

export function WorkEvidence({
  workspaceId,
  sessionId,
  from,
  to,
}: {
  workspaceId: string | null;
  sessionId?: string;
  from: string;
  to: string;
}) {
  const [refresh, setRefresh] = useState(0);
  return (
    <section style={{ marginTop: 14 }}>
      <ReportedWork workspaceId={workspaceId} refresh={refresh} />
      {workspaceId !== null && (
        <WorkRecordControls
          workspaceId={workspaceId}
          {...(sessionId === undefined ? {} : { sessionId })}
          from={from}
          to={to}
          onMutationComplete={() => setRefresh((value) => value + 1)}
        />
      )}
    </section>
  );
}

function ReportedWork({ workspaceId, refresh }: { workspaceId: string | null; refresh: number }) {
  const [data, setData] = useState<ReportedWorkSummary | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error" | "unavailable">("loading");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    void refresh;
    void retry;
    let active = true;
    setStatus("loading");
    const params = new URLSearchParams();
    if (workspaceId !== null) params.set("workspace_id", workspaceId);
    void fetch(`/api/work-records/summary?${params}`, { signal: AbortSignal.timeout(8000) })
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 404 || response.status === 503) {
            if (active) setStatus("unavailable");
            return;
          }
          throw new Error("request failed");
        }
        const result = (await response.json()) as ApiResponse<ReportedWorkSummary>;
        if (active) {
          setData(result.data);
          setStatus(result.data === null ? "unavailable" : "ok");
        }
      })
      .catch(() => {
        if (active) setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [workspaceId, refresh, retry]);
  return (
    <section aria-label="Useful work reported">
      <h3>Useful work (reported)</h3>
      <p>
        Current retained records ·{" "}
        {workspaceId === null ? "all workspaces" : `workspace ${workspaceId}`}. Independent of the
        selected spend window.
      </p>
      {status === "loading" && <p aria-busy="true">Loading reported work…</p>}
      {status === "unavailable" && <p>Reported work unavailable.</p>}
      {status === "error" && (
        <p role="alert">
          Reported work request failed.{" "}
          <button
            className="btn-secondary"
            type="button"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry reported work
          </button>
        </p>
      )}
      {status === "ok" && data !== null && (
        <>
          {data.records_total === 0 ? (
            <div className="work-record-empty">
              <p>No current work records in this scope.</p>
              <p>Report outcomes to see cost per useful task.</p>
              {workspaceId !== null && (
                <button
                  className="btn-secondary"
                  type="button"
                  aria-controls="work-record-create"
                  onClick={focusCreateForm}
                >
                  Create a work record
                </button>
              )}
            </div>
          ) : (
            <>
              <p>
                {data.useful} useful / {data.reported_terminal} reported terminal records
                {data.reported_terminal === 0 &&
                  " · useful-work rate unknown (no reported terminal records)"}
                .
              </p>
              <p>
                Feedback coverage: {data.reported} / {data.records_total} current records.
              </p>
              <OutcomeBar data={data} />
            </>
          )}
          <details>
            <summary>Reported work scope and limits</summary>
            <p>
              As of {data.as_of}. {data.archived_count} archived records included. Deleted records
              are absent. Allocation coverage requires a frozen report for its named cohort; pricing
              coverage is shown with resource use.
            </p>
            <p>
              UNREPORTED means no feedback. UNKNOWN is explicitly reported. Activity does not
              determine either.
            </p>
          </details>
        </>
      )}
    </section>
  );
}

function OutcomeBar({ data }: { data: ReportedWorkSummary }) {
  return (
    <div className="work-outcome-summary" aria-label="Reported work outcomes">
      <div
        className="work-outcome-terminal-bar"
        aria-label={`${data.reported_terminal} reported terminal records`}
        data-testid="reported-work-outcome-bar"
      >
        {TERMINAL_OUTCOMES.map((outcome) => {
          const count = data.outcome_counts[outcome];
          return (
            <span
              key={outcome}
              className={`work-outcome-segment work-outcome-${outcome.toLowerCase()}`}
              style={{ flexGrow: count, flexBasis: 0 }}
            >
              {outcome} {count}
            </span>
          );
        })}
      </div>
      <div className="work-outcome-outside" aria-label="Outcomes outside the terminal denominator">
        {OUTSIDE_TERMINAL_OUTCOMES.map((outcome) => (
          <span
            key={outcome}
            className={`work-outcome-segment work-outcome-${outcome.toLowerCase()}`}
          >
            {outcome} {data.outcome_counts[outcome]}
          </span>
        ))}
      </div>
      <p>
        Terminal denominator: {data.reported_terminal} records (USEFUL, PARTIAL, UNSUCCESSFUL,
        ABANDONED only). ACTIVE, UNKNOWN, and UNREPORTED are outside this denominator.
      </p>
    </div>
  );
}
