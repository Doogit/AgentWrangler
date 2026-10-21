/**
 * src/ui/shell/StatusChip.tsx — the shell's boot and background-scan status (P1-U5).
 *
 * The SPA mounts before the daemon is ready, so boot progress lives here instead of in
 * a blocking overlay: a small chip with the phase ("Reading last 7 days", "Reading
 * history · N of ~M days", …) and a click-open popover holding the scan log and, after
 * BOOT_MAX_WAIT_MS without readiness, the "could not start" escalation the old boot
 * overlay showed. It reads the shared status poller (P2-U5), as do App's unreachable check,
 * the Sidebar and PipelineStatusBar.
 *
 * SEC-101: renders phase labels, integer counts and the server's aggregate-only event text.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { DaemonStatus } from "../api/client";
import { notePrefetchStatus } from "../api/prefetch";
import { useStatusPoller } from "../api/status-poller";

/** Without readiness for this long after mount, the chip escalates (the old overlay's timeout). */
export const BOOT_MAX_WAIT_MS = 30_000;

const LOG_LINES = 5;
const DAYS_PER_WEEK = 7;

/** /api/status carries the boot-progress fields only until /api/ready is true. */
function isPreReady(status: DaemonStatus): boolean {
  return status.boot_files_total !== undefined;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function chipLabel(status: DaemonStatus | null, escalated: boolean): string {
  if (escalated) return "Startup needs attention";
  if (status === null) return "Connecting…";
  if (isPreReady(status)) {
    const total = status.boot_files_total ?? 0;
    return total > 0
      ? `Reading last 7 days · ${count(status.files_seen)} of ${count(total)} files`
      : "Reading last 7 days";
  }
  const pipeline = status.pipeline;
  if (pipeline === undefined) return "Up to date";
  if (pipeline.failed_phase) return "Scan error";
  if (pipeline.phase === "reading") {
    return pipeline.files_total > 0
      ? `Reading sessions · ${count(pipeline.files_completed)} of ${count(pipeline.files_total)} files`
      : "Reading sessions";
  }
  if (pipeline.phase === "detecting") return "Detecting patterns";
  if (pipeline.phase === "history") {
    // Days, not weeks (review M36). Before discovery lists the files the total is unknown.
    const done = (pipeline.weeks_done ?? 0) * DAYS_PER_WEEK;
    const total = (pipeline.weeks_total ?? 0) * DAYS_PER_WEEK;
    return total > 0
      ? `Reading history · ${done} of ~${total} days`
      : `Reading history · ${done} days`;
  }
  return "Up to date";
}

function logLines(status: DaemonStatus | null): string[] {
  if (status === null) return [];
  const lines = isPreReady(status)
    ? (status.boot_scan_events ?? []).map((event) => event.text)
    : (status.pipeline?.events ?? []);
  return lines.filter(Boolean).slice(-LOG_LINES);
}

export default function StatusChip(): React.ReactElement {
  // The poller keeps the last status through failures; App owns the unreachable card.
  const { status } = useStatusPoller();
  const [readySeen, setReadySeen] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (status === null) return;
    // P1-U6a: prefetch pauses during backfill / high loop lag.
    notePrefetchStatus(status);
    if (!isPreReady(status)) setReadySeen(true);
  }, [status]);

  useEffect(() => {
    const id = window.setTimeout(() => setTimedOut(true), BOOT_MAX_WAIT_MS);
    return () => window.clearTimeout(id);
  }, []);

  const escalated = timedOut && !readySeen;
  const label = chipLabel(status, escalated);
  const busy = !escalated && status !== null && label !== "Up to date" && label !== "Scan error";
  const log = logLines(status);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="status-chip-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="status-chip"
        data-state={escalated ? "error" : busy ? "busy" : "idle"}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            close();
          }
        }}
      >
        <span className="status-chip-dot" aria-hidden="true" />
        {label}
      </button>
      {open && (
        <section
          id={popoverId}
          className="status-chip-popover card"
          aria-label="Background status"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        >
          {escalated && (
            <div className="status-chip-escalation" role="alert">
              <h2>Dashboard could not start</h2>
              <p>
                The local dashboard did not become ready within {BOOT_MAX_WAIT_MS / 1_000} seconds.
                Check the terminal that started AgentWrangler, restart it, then reload this page.
              </p>
              <p>
                <a href="#/help?topic=troubleshooting&section=daemon">Open recovery Help</a>
              </p>
            </div>
          )}
          <p className="status-chip-summary">{label}</p>
          {status !== null && (
            <p className="status-chip-meta">
              {count(status.sessions)} sessions · {count(status.files_parsed)} files read
            </p>
          )}
          {log.length > 0 && (
            <ul className="status-chip-log" aria-label="Scan activity">
              {log.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the log is an append-only tail.
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
