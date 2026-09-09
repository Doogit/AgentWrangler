import { useEffect, useState } from "react";
import type { ReportedWorkSummary } from "../../query/api/reported-work";
import type { ApiResponse } from "../../query/envelope";
import { WorkRecordControls } from "./work-records/WorkRecordControls";

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
            <p>No current work records in this scope.</p>
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
            </>
          )}
          <details>
            <summary>Reported work scope and limits</summary>
            <p>
              As of {data.as_of}. {data.archived_count} archived records included. Deleted records
              are absent. Allocation coverage requires a frozen report for its named cohort; pricing
              coverage is shown with resource use.
            </p>
            <ul>
              {Object.entries(data.outcome_counts).map(([outcome, count]) => (
                <li key={outcome}>
                  {outcome}: {count}
                </li>
              ))}
            </ul>
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
