/**
 * src/ui/diagnostics/DiagnosticsPage.tsx — the Diagnostics triage page (P4 U5).
 *
 * Serves `DiagnosticsTriageView` (via `DiagnosticsPayload`, U4's route): four tiles, the
 * Avoidable spend section, then Reliability with the risk row last. A cold window returns
 * `{ status: "building", progress }` at once; the page shows its own skeleton for the first
 * ~1 s, then a `LoadProgress` card (R27) while it polls. A stale-but-served snapshot renders
 * immediately with a quiet "refreshing" indicator.
 */

import { useEffect, useRef, useState } from "react";
import type { DiagnosticsBuildProgress, DiagnosticsReady } from "../../query/api";
import { fetchDiagnostics, fetchStatus } from "../api/client";
import { KpiCard } from "../overview/KpiCard";
import AsyncErrorState from "../shell/AsyncErrorState";
import InfoTip from "../shell/InfoTip";
import LoadProgress from "../shell/LoadProgress";
import PartialBadge from "../shell/PartialBadge";
import { SkeletonBlock } from "../shell/Skeleton";
import AvoidableSection from "./AvoidableSection";
import ReliabilitySection from "./ReliabilitySection";
import { countOf, money, pct } from "./format";

type WindowDays = 7 | 14 | 30;

type PageState =
  | { kind: "loading" }
  | { kind: "building"; progress: DiagnosticsBuildProgress; revealed: boolean }
  | { kind: "error"; message: string }
  | { kind: "ready"; value: DiagnosticsReady; pipelinePartial: boolean };

const POLL_MS = 1_000;
const REVEAL_MS = 1_000;

type CauseRow =
  | DiagnosticsReady["avoidable"]["causes"][number]
  | DiagnosticsReady["reliability"]["causes"][number];

/** Names what the rows without an active fix show instead (Small fix / No fix this week / No fix yet). */
function restCaption(rows: CauseRow[]): string {
  let small = 0;
  let quiet = 0;
  let none = 0;
  for (const row of rows) {
    if (row.fix_small) small += 1;
    else if (row.handoff) continue;
    else if (row.fix_quiet) quiet += 1;
    else none += 1;
  }
  const parts = [
    small > 0 ? `${small} small fix` : null,
    quiet > 0 ? `${quiet} no fix this week` : null,
    none > 0 ? `${none} no fix yet` : null,
  ].filter((part) => part !== null);
  return `the rest: ${parts.join(" · ")}`;
}

function windowFromHash(): WindowDays {
  const value = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("window");
  return value === "14" ? 14 : value === "30" ? 30 : 7;
}

function DiagnosticsSkeleton() {
  return (
    <>
      <section className="sec grid g4" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card kpi skeleton" style={{ height: 120 }} />
        ))}
      </section>
      {[0, 1].map((section) => (
        <div key={section} className="triage-skeleton-section" aria-hidden="true">
          <SkeletonBlock height={22} />
          {[0, 1, 2].map((row) => (
            <SkeletonBlock key={row} height={72} />
          ))}
        </div>
      ))}
    </>
  );
}

export default function DiagnosticsPage() {
  const [request, setRequest] = useState(() => ({ windowDays: windowFromHash(), attempt: 0 }));
  const windowDays = request.windowDays;
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const revealedRef = useRef(false);

  useEffect(() => {
    const sync = () => {
      const days = windowFromHash();
      const rawWindow = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("window");
      if (rawWindow !== String(days)) window.location.hash = `#/diagnostics?window=${days}`;
      setRequest((current) =>
        current.windowDays === days ? current : { windowDays: days, attempt: 0 },
      );
    };
    window.addEventListener("hashchange", sync);
    sync();
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    let active = true;
    let pollId: ReturnType<typeof setTimeout> | undefined;
    revealedRef.current = false;
    setState({ kind: "loading" });
    const revealId = setTimeout(() => {
      revealedRef.current = true;
      setState((current) =>
        current.kind === "building" ? { ...current, revealed: true } : current,
      );
    }, REVEAL_MS);
    const poll = () => {
      void fetchDiagnostics(request.windowDays)
        .then(async (response) => {
          if (!active) return;
          if (response.data === null) throw new Error("No diagnostics response");
          const data = response.data;
          if (data.status === "building") {
            setState({ kind: "building", progress: data.progress, revealed: revealedRef.current });
            pollId = setTimeout(poll, POLL_MS);
            return;
          }
          const status = await fetchStatus().catch(() => null);
          if (!active) return;
          setState({
            kind: "ready",
            value: data,
            pipelinePartial:
              data.partial || (status?.pipeline !== undefined && status.pipeline.phase !== "done"),
          });
          // F9: hand-offs are unknown until the recs snapshot builds; poll until they land.
          if (data.handoffs_pending === true) pollId = setTimeout(poll, POLL_MS);
        })
        .catch(() => {
          if (active)
            setState({ kind: "error", message: "Could not load diagnostics for this window." });
        });
    };
    poll();
    return () => {
      active = false;
      clearTimeout(revealId);
      clearTimeout(pollId);
    };
  }, [request]);

  const windowControl = (
    // biome-ignore lint/a11y/useSemanticElements: matches the WorkspacesPage segmented date-range control (C1)
    <div className="date-range" role="group" aria-label="Usage patterns window">
      {([7, 14, 30] as const).map((days) => (
        <button
          key={days}
          type="button"
          className={`date-preset-btn${windowDays === days ? " active" : ""}`}
          aria-pressed={windowDays === days}
          onClick={() => {
            setRequest((current) => ({ windowDays: days, attempt: current.attempt + 1 }));
            window.location.hash = `#/diagnostics?window=${days}`;
          }}
        >
          {days}d
        </button>
      ))}
    </div>
  );

  const header = () => {
    const ready = state.kind === "ready" ? state : null;
    const refreshingLabel =
      ready && ready.value.refreshing === true && ready.value.snapshot_at !== undefined
        ? `Updated ${Math.max(0, Math.round((Date.now() - Date.parse(ready.value.snapshot_at)) / 60_000))} min ago · refreshing…`
        : null;
    return (
      <div className="page-top">
        <div className="page-title">
          <h1>
            Usage patterns
            {ready?.pipelinePartial && <PartialBadge variant="may-change" />}
          </h1>
          <p className="page-sub">
            What is costing you, why it happens, and the one fix for each cause.{" "}
            <InfoTip
              label="About Usage patterns"
              content="Why spend and failures happen. The fixes live in Recommendations."
            />
            {refreshingLabel !== null && (
              <>
                {" · "}
                <span className="diagnostics-refreshing">{refreshingLabel}</span>
              </>
            )}
          </p>
        </div>
        <div className="page-top-controls">{windowControl}</div>
      </div>
    );
  };

  if (state.kind === "loading" || (state.kind === "building" && !state.revealed))
    return (
      <div className="page diagnostics-page" aria-busy="true" aria-label="Loading usage patterns">
        {header()}
        <DiagnosticsSkeleton />
      </div>
    );

  if (state.kind === "building")
    return (
      <div className="page diagnostics-page" aria-busy="true" aria-label="Loading usage patterns">
        {header()}
        <div className="diagnostics-loading">
          <DiagnosticsSkeleton />
          <LoadProgress
            label="Building usage patterns"
            stage={state.progress.stage}
            step={state.progress.step}
            steps={state.progress.steps}
            startedAt={state.progress.started_at}
            expectedMs={state.progress.expected_ms}
          />
        </div>
      </div>
    );

  if (state.kind === "error")
    return (
      <div className="page diagnostics-page">
        {header()}
        <AsyncErrorState
          resource="route-page"
          onRetry={() => setRequest((current) => ({ ...current, attempt: current.attempt + 1 }))}
        />
      </div>
    );

  const { value } = state;
  const handoffPending = value.handoffs_pending === true;
  const silent = [...(value.avoidable.silent ?? []), ...(value.reliability.silent ?? [])];

  return (
    <div className="page diagnostics-page">
      {header()}
      <section className="sec grid g4" aria-label="Usage patterns tiles">
        <KpiCard
          label="Spend in window"
          info="Total recorded spend across sessions in the selected window."
          value={money(value.tiles.spend_u)}
          cmp={countOf(value.tiles.session_count, "sessions")}
        />
        <KpiCard
          label="Avoidable spend"
          info={
            value.tiles.avoidable_share === null
              ? "Not estimated: no cause has a dollar figure yet, so none is shown. Dollar figures land in a later release; until then causes are ranked by how often they happen."
              : value.tiles.avoidable_through
                ? `Modeled dollars behind causes with an estimate, over whole UTC days through ${new Date(Date.parse(value.tiles.avoidable_through) - 86_400_000).toISOString().slice(0, 10)} (UTC), so up to a day behind. The share is of spend over those same days, so it can differ slightly from the spend tile. The same figures as the matching recommendation cards.`
                : "Modeled share of this window's spend behind causes with a dollar estimate. The same figures as the matching recommendation cards."
          }
          value={
            value.tiles.avoidable_share === null
              ? "Not estimated"
              : pct(value.tiles.avoidable_share)
          }
          cmp={
            value.tiles.avoidable_u === null
              ? "Dollar figures land later"
              : `≈ ${money(value.tiles.avoidable_u)} · same figures as rec cards`
          }
        />
        <KpiCard
          label="Sessions with friction"
          info={`Share of sessions hit by any Reliability cause below in this window: blocked, failed, looping, or interrupted work${
            value.reliability.causes.length > 0
              ? ` (${value.reliability.causes.map((row) => row.name).join("; ")})`
              : ""
          }. Destructive commands are not counted. Each row's "view all" lists its sessions.`}
          value={value.tiles.friction_share === null ? "—" : pct(value.tiles.friction_share)}
          cmp={`${countOf(value.tiles.friction_sessions, "sessions")} · any Reliability cause below`}
        />
        <KpiCard
          label="Causes with a fix ready"
          info="How many listed causes already link to a recommendation you can act on."
          value={
            handoffPending
              ? "Checking…"
              : `${value.tiles.fix_ready.n} of ${value.tiles.fix_ready.m}`
          }
          cmp={
            handoffPending
              ? "checking for a fix while recommendations build"
              : value.tiles.fix_ready.n < value.tiles.fix_ready.m
                ? restCaption([...value.avoidable.causes, ...value.reliability.causes])
                : undefined
          }
        />
      </section>
      <AvoidableSection
        key={windowDays}
        causes={value.avoidable.causes}
        banner={value.avoidable.banner}
        windowDays={windowDays}
        handoffPending={handoffPending}
      />
      <ReliabilitySection
        causes={value.reliability.causes}
        risk={value.reliability.risk}
        windowDays={windowDays}
        handoffPending={handoffPending}
      />
      {silent.length > 0 && (
        <p className="triage-panel-note diagnostics-silent">
          Also watched, nothing in this window: {silent.map((c) => c.name).join(", ")}.
        </p>
      )}
    </div>
  );
}
