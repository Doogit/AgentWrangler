/**
 * src/ui/shell/PipelineStatusBar.tsx — dismissable bottom status bar for the
 * post-ready background pipeline (U4).
 *
 * VS Code window/progress model: a persistent bottom bar that shows
 * reading → detecting → done progress, expandable log, retry on error, and a
 * completion CTA. Never blocks the app; self-hides when no pipeline data.
 *
 * SEC-101: renders ONLY phase labels, integer counts, and workspace ids/slugs
 * (whatever the server already gated). Never surfaces raw transcript content.
 */

import { useEffect, useRef, useState } from "react";
import { type BackgroundJob, type PipelineStatus, retryPipeline } from "../api/client";
import { useStatusPoller } from "../api/status-poller";
import { StatusSpinner, buildingMeta, useElapsedMs } from "./SectionStatus";

/** Auto-dismiss the completion confirmation after this many ms. */
const COMPLETION_DISMISS_MS = 8_000;

/** Module-scope dismissed flag (in-memory, session-local — intentionally NOT localStorage). */
let _dismissed = false;

/** Reset the dismissed flag. Only for tests. */
export function _resetDismissState(): void {
  _dismissed = false;
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** One cold background build (OV-13): spinner, label, elapsed/usual, link to its page. */
function JobRow({ job, actions }: { job: BackgroundJob; actions?: React.ReactNode }) {
  const elapsed = useElapsedMs(job.started_at);
  const label =
    job.kind === "recommendations"
      ? "Building recommendations"
      : `Building usage patterns${job.window_days === undefined ? "" : ` (last ${job.window_days} days)`}`;
  return (
    <div className="pipeline-bar-job">
      <StatusSpinner />
      <span className="pipeline-bar-job-label">{label}</span>
      {elapsed !== null && (
        <span className="section-status-meta">{buildingMeta(elapsed, job.expected_ms)}</span>
      )}
      <a
        href={job.kind === "recommendations" ? "#/recommendations" : "#/diagnostics"}
        className="pipeline-bar-job-link"
      >
        Show
      </a>
      {actions}
    </div>
  );
}

export default function PipelineStatusBar(): React.ReactElement | null {
  const [pipeline, setPipeline] = useState<PipelineStatus | null>(null);
  const [dismissed, setDismissed] = useState(_dismissed);
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const [completionVisible, setCompletionVisible] = useState(false);
  const retryAbortRef = useRef<AbortController | null>(null);
  const prevPhaseRef = useRef<string | null>(null);
  const firstDeliveryRef = useRef(true);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The poller keeps the last status through failures, so an error keeps the last pipeline state.
  const { status } = useStatusPoller();
  useEffect(() => {
    if (status === null) return;
    const ps = status.pipeline ?? null;
    setPipeline(ps);

    // Skip the done-transition on the first delivery: a page load that finds
    // the pipeline already done is not a done-transition and must not flash
    // the completion confirmation.
    if (firstDeliveryRef.current) {
      firstDeliveryRef.current = false;
      prevPhaseRef.current = ps?.phase ?? null;
      return;
    }

    // Transition to done: show completion confirmation (unless dismissed before done).
    if (ps?.phase === "done" && prevPhaseRef.current !== "done") {
      if (!_dismissed) {
        setCompletionVisible(true);
        if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
        completionTimerRef.current = setTimeout(() => {
          setCompletionVisible(false);
        }, COMPLETION_DISMISS_MS);
      }
    }
    prevPhaseRef.current = ps?.phase ?? null;
  }, [status]);

  // Cleanup timer + in-flight retry on unmount.
  useEffect(() => {
    return () => {
      if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
      retryAbortRef.current?.abort();
    };
  }, []);

  function handleDismiss(): void {
    _dismissed = true;
    setDismissed(true);
    setCompletionVisible(false);
    if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
  }

  async function handleRetry(): Promise<void> {
    setRetrying(true);
    setRetryError(false);
    const controller = new AbortController();
    retryAbortRef.current = controller;
    try {
      await retryPipeline(controller.signal);
    } catch {
      // Surface the failure so the user knows the retry didn't land; ignore an
      // abort fired by unmount (no live component to update).
      if (!controller.signal.aborted) setRetryError(true);
    } finally {
      if (!controller.signal.aborted) setRetrying(false);
    }
  }

  const jobs = status?.jobs ?? [];
  const failed = pipeline?.failed_phase ?? null;

  // Dismissed and no error → render nothing. A dismissed bar re-appears only if
  // the pipeline later fails (failed_phase set), so the user can retry a failure
  // they didn't opt out of.
  if (dismissed && !failed) return null;

  // The pipeline row shows unless there is no pipeline data, or it is done and
  // the completion confirmation is gone. Cold builds (`jobs`) show either way.
  const showPipeline = pipeline !== null && (pipeline.phase !== "done" || completionVisible);
  if (!showPipeline && jobs.length === 0) return null;

  const phase = pipeline?.phase;
  const isActive = phase === "reading" || phase === "detecting" || phase === "history";
  // The log belongs to the scan row; with only job rows there is nothing to show.
  const events = showPipeline ? pipeline.events : [];

  const actions = (
    <div className="pipeline-bar-actions">
      {events.length > 0 && (
        <button
          type="button"
          className="btn-secondary pipeline-bar-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? "Hide log" : "Show log"}
        </button>
      )}
      <button
        type="button"
        className="btn-secondary pipeline-bar-close"
        onClick={handleDismiss}
        aria-label="Dismiss pipeline status"
      >
        ✕
      </button>
    </div>
  );

  function renderPhaseRow(ps: PipelineStatus): React.ReactElement {
    const { files_total, files_completed, failed_phase, weeks_done, weeks_total } = ps;
    if (completionVisible && phase === "done") {
      return (
        <span className="pipeline-bar-phase">
          Background scan complete. {/* TODO(U14): retarget to the R8 findings tab */}
          <a href="#/diagnostics" className="pipeline-bar-cta">
            View usage patterns
          </a>
        </span>
      );
    }

    if (failed_phase) {
      return (
        <span className="pipeline-bar-phase pipeline-bar-error">
          Pipeline error at <strong>{failed_phase}</strong> phase.{" "}
          <button
            type="button"
            className="btn-secondary pipeline-bar-retry"
            onClick={() => void handleRetry()}
            disabled={retrying}
          >
            Retry {failed_phase}
          </button>
          {retryError && (
            <span role="alert"> Retry request failed — check the daemon and try again.</span>
          )}
        </span>
      );
    }

    if (isActive) {
      if (phase === "history") {
        return (
          <span className="pipeline-bar-phase" aria-live="polite">
            Scanning history — week {weeks_done ?? 0} of {weeks_total ?? 0}
          </span>
        );
      }
      const phaseLabel = phase === "reading" ? "Reading sessions" : "Detecting patterns";
      const countRow =
        files_total > 0
          ? `${formatCount(files_completed)} / ${formatCount(files_total)} files`
          : null;
      return (
        <span className="pipeline-bar-phase" aria-live="polite">
          {phaseLabel}
          {countRow ? <span className="pipeline-bar-count"> — {countRow}</span> : "…"}
        </span>
      );
    }

    return <span className="pipeline-bar-phase">Processing…</span>;
  }

  return (
    <output
      className="pipeline-bar card"
      aria-live="polite"
      aria-label="Background pipeline status"
      data-reserves-space="true"
    >
      {showPipeline && (
        <div className="pipeline-bar-row">
          <span className="pipeline-bar-indicator" aria-hidden="true">
            {failed ? "✕" : isActive ? "⟳" : "✓"}
          </span>
          {renderPhaseRow(pipeline)}
          {actions}
        </div>
      )}
      {jobs.map((job, i) => (
        <JobRow
          key={`${job.kind}-${job.window_days ?? ""}`}
          job={job}
          actions={!showPipeline && i === 0 ? actions : undefined}
        />
      ))}
      {expanded && events.length > 0 && (
        <div className="pipeline-bar-log" role="log" aria-label="Pipeline log">
          <div className="pipeline-bar-log-body">
            {events.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: log lines are append-only; index is stable and correct here
              <div key={i} className="pipeline-bar-log-line">
                {line}
              </div>
            ))}
          </div>
        </div>
      )}
    </output>
  );
}
