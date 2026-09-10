import { useEffect, useId, useRef, useState } from "react";
import type { EsfObservationCohort } from "../../query/api/esf-observations";
import type { SessionSummary, WindowFilter } from "../../query/api/overview";
import { fetchEsfObservations, fetchSessionEsfObservations } from "../api/esf-client";

import { WorkEvidence } from "./WorkEvidence";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; cohort: EsfObservationCohort | null };

function money(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function DateRange({ lead, from, to }: { lead: string; from: string; to: string }) {
  return (
    <span style={{ overflowWrap: "anywhere" }}>
      {lead} from {from} up to, but not including, {to}.
    </span>
  );
}

function SessionLinks({ ids, label }: { ids: string[]; label: string }) {
  if (ids.length === 0) return <span>No {label.toLowerCase()}.</span>;
  return (
    <span>
      {label}:{" "}
      {ids.map((id, index) => (
        <span key={id}>
          {index > 0 ? ", " : ""}
          <a href={`#/sessions/${encodeURIComponent(id)}`}>{id}</a>
        </span>
      ))}
    </span>
  );
}

function DetailDisclosure({
  cohort,
  launcher,
}: { cohort: EsfObservationCohort; launcher: React.RefObject<HTMLButtonElement> }) {
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (open) headingRef.current?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    launcher.current?.focus();
  };
  return (
    <div style={{ marginTop: 10 }}>
      <button
        ref={launcher}
        type="button"
        className="btn-secondary"
        aria-expanded={open}
        aria-controls={headingId}
        onClick={() => (open ? close() : setOpen(true))}
      >
        View evidence and limits
      </button>
      {open && (
        <dialog
          open
          className="card"
          aria-modal="false"
          aria-labelledby={headingId}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          style={{
            position: "static",
            width: "auto",
            margin: "10px 0 0",
            padding: 14,
            color: "inherit",
          }}
        >
          <h3 ref={headingRef} id={headingId} tabIndex={-1}>
            Evidence and limits
          </h3>
          <p>
            <DateRange lead="This data includes entries" from={cohort.from} to={cohort.to} />{" "}
            Resource totals include {cohort.resource.selected_session_count} selected sessions;
            priced and unpriced turns are separate.
          </p>
          <p>
            Repeated test-failure observation uses method{" "}
            {cohort.observed_test_recovery.method_version}:{" "}
            {cohort.observed_test_recovery.affected_session_ids.length} affected sessions of{" "}
            {cohort.observed_test_recovery.eligible_reconciled_qualifying_tool_session_count}{" "}
            eligible RECONCILED qualifying-tool sessions. A recovered sequence records a later
            observed pass; it does not establish task success or a detector match.
          </p>
          <p>
            Reconciled Bash/edit activity without an observed commit is a separate activity cohort.
            LIVE sessions are excluded from that activity cohort.
          </p>
          <p>
            <SessionLinks
              label="Affected stable IDs"
              ids={cohort.observed_test_recovery.affected_session_ids}
            />
          </p>
          <p>
            <SessionLinks
              label="Recovered stable IDs"
              ids={cohort.observed_test_recovery.recovered_session_ids}
            />
          </p>
          <p>
            <SessionLinks
              label="No-commit activity stable IDs"
              ids={cohort.no_commit_activity.session_ids}
            />
          </p>
          <p>
            Cohort method: {cohort.cohort_definition_version}. Provisional turns excluded from
            money:{" "}
            {cohort.watermark.selected_turn_count - cohort.watermark.nonprovisional_turn_count}.
            Interrupt rate unavailable (not collected).
          </p>
          <button type="button" className="btn-secondary" onClick={close}>
            Back
          </button>
        </dialog>
      )}
    </div>
  );
}

export function ObservationEvidence({
  workspaceId,
  filter,
  title = "Observed evidence",
}: { workspaceId: string | null; filter: WindowFilter; title?: string | null }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const launcher = useRef<HTMLButtonElement>(null);
  const { from, to, preset } = filter;
  useEffect(() => {
    void retry; // Explicit retry invalidates this read even when its scope is unchanged.
    let active = true;
    setState({ status: "loading" });
    void fetchEsfObservations(workspaceId, {
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(preset === undefined ? {} : { preset }),
    })
      .then((response) => {
        if (active) setState({ status: "ok", cohort: response.data });
      })
      .catch((error: unknown) => {
        if (active) setState({ status: "error", message: String(error) });
      });
    return () => {
      active = false;
    };
  }, [workspaceId, from, to, preset, retry]);
  return (
    <section
      className="card"
      data-testid="esf-observation-evidence"
      style={{ marginBottom: 13, padding: 14, minHeight: 142 }}
    >
      {title !== null && (
        <div className="section-head">
          <h2>{title}</h2>
        </div>
      )}
      {state.status === "loading" && (
        <div aria-busy="true" style={{ minHeight: 84 }}>
          Loading observations…
        </div>
      )}
      {state.status === "error" && (
        <div role="alert">
          Observation request failed — {state.message}{" "}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {state.status === "ok" && state.cohort === null && (
        <div>No eligible observations in this window.</div>
      )}
      {state.status === "ok" && state.cohort !== null && (
        <>
          <CohortSummary cohort={state.cohort} launcher={launcher} />
          <WorkEvidence workspaceId={workspaceId} from={state.cohort.from} to={state.cohort.to} />
        </>
      )}
    </section>
  );
}

function CohortSummary({
  cohort,
  launcher,
}: { cohort: EsfObservationCohort; launcher: React.RefObject<HTMLButtonElement> }) {
  const { resource, observed_test_recovery: recovery } = cohort;
  if (resource.selected_session_count === 0)
    return <div>No eligible observations in this window.</div>;
  return (
    <>
      <p style={{ marginTop: 0, fontSize: 12, color: "var(--text-muted)" }}>
        <DateRange
          lead={
            cohort.workspace_id === null
              ? "This overview includes data"
              : "This workspace includes data"
          }
          from={cohort.from}
          to={cohort.to}
        />
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
        }}
      >
        <div>
          <strong>Resource use</strong>
          <div>
            {money(resource.priced_cost_u)} priced · {resource.priced_turn_count} priced turns
          </div>
          <small>
            {resource.unpriced_turn_count} unpriced turns · {resource.live_priced_session_count}{" "}
            priced LIVE sessions
          </small>
        </div>
        <div>
          <strong>Observed workflow</strong>
          <div>
            {recovery.affected_session_ids.length} /{" "}
            {recovery.eligible_reconciled_qualifying_tool_session_count} repeated test-failure
            sessions
          </div>
          <small>{recovery.recovered_session_ids.length} recovered test sequences</small>
        </div>
      </div>
      <p style={{ marginBottom: 0, fontSize: 12 }}>
        {cohort.no_commit_activity.session_count} reconciled Bash/edit activity without an observed
        commit; {cohort.no_commit_activity.live_session_excluded_count} LIVE sessions excluded from
        this activity cohort.
      </p>
      <DetailDisclosure cohort={cohort} launcher={launcher} />
    </>
  );
}

export function SessionObservedEvidence({ session }: { session: SessionSummary }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const launcher = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    void retry;
    let active = true;
    setState({ status: "loading" });
    void fetchSessionEsfObservations(session.session_id)
      .then((response) => {
        if (active) setState({ status: "ok", cohort: response.data });
      })
      .catch((error: unknown) => {
        if (active) setState({ status: "error", message: String(error) });
      });
    return () => {
      active = false;
    };
  }, [session.session_id, retry]);
  const cohort = state.status === "ok" ? state.cohort : null;
  const recovered = cohort?.observed_test_recovery.recovered_session_ids.includes(
    session.session_id,
  );
  const hasFailure = cohort?.observed_test_recovery.affected_session_ids.includes(
    session.session_id,
  );
  return (
    <section
      className="card"
      data-testid="esf-session-observed-evidence"
      style={{ marginBottom: 13, padding: 14 }}
    >
      <div className="section-head">
        <h2>Observed evidence</h2>
      </div>
      <p>
        {session.session_id} · {session.state}
      </p>
      {state.status === "loading" && <p aria-busy="true">Loading session observations…</p>}
      {state.status === "error" && (
        <p role="alert">
          Session observation request failed — {state.message}{" "}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </p>
      )}
      {state.status === "ok" && cohort === null && <p>Session evidence unavailable.</p>}
      {cohort !== null && cohort.resource.selected_session_count === 0 && (
        <p>No eligible observations in this session.</p>
      )}
      {cohort !== null && cohort.resource.selected_session_count > 0 && (
        <>
          <p>
            <DateRange
              lead="This complete session includes data"
              from={cohort.from}
              to={cohort.to}
            />
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            <div>
              <strong>Resource</strong>
              <div>
                {money(cohort.resource.priced_cost_u)} priced; {cohort.resource.unpriced_turn_count}{" "}
                unpriced turns
              </div>
              <small>
                {cohort.resource.priced_turn_count} priced turns; unpriced cost is unknown.
              </small>
            </div>
            <div>
              <strong>Operational sequence</strong>
              <div>
                {session.state === "LIVE"
                  ? "LIVE — excluded from reconciled observation cohort"
                  : recovered
                    ? "repeated test failures, then an observed later pass"
                    : hasFailure
                      ? "repeated test failures observed"
                      : "no repeated test-failure sequence observed"}
              </div>
            </div>
          </div>
          <p>
            {session.state === "LIVE"
              ? "LIVE — excluded from reconciled activity cohort."
              : cohort.no_commit_activity.session_ids.includes(session.session_id)
                ? "Qualifying Bash/edit activity without an observed commit."
                : "Outside the no-commit activity cohort."}{" "}
            Interrupt rate unavailable (not collected). This observation does not infer task success
            or a matching recommendation.
          </p>
          <DetailDisclosure cohort={cohort} launcher={launcher} />
        </>
      )}
      {cohort !== null && (
        <WorkEvidence
          workspaceId={session.workspace_id}
          sessionId={session.session_id}
          from={cohort.from}
          to={cohort.to}
        />
      )}
    </section>
  );
}
