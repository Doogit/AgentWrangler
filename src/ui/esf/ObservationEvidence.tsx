import { useEffect, useId, useRef, useState } from "react";
import type { EsfObservationCohort } from "../../query/api/esf-observations";
import type { SessionSummary, WindowFilter } from "../../query/api/overview";
import { fetchEsfObservations, fetchSessionEsfObservations } from "../api/esf-client";
import { shortId } from "../lib/short-id";
import StateChip from "../shell/StateChip";

import { WorkEvidence } from "./WorkEvidence";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ok";
      cohort: EsfObservationCohort | null;
      prior: EsfObservationCohort | null;
    };

function money(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function DateRange({ lead, from, to }: { lead: string; from: string; to: string }) {
  const elapsed = Date.parse(to) - Date.parse(from);
  const label =
    elapsed === 24 * 60 * 60 * 1000
      ? "last 24 hours"
      : elapsed === 7 * 24 * 60 * 60 * 1000
        ? "last 7 days"
        : Number.isFinite(elapsed) && elapsed > 0
          ? `last ${Math.round(elapsed / (24 * 60 * 60 * 1000))} days`
          : "selected window";
  return (
    <div style={{ display: "inline" }}>
      {lead} for {label}.{" "}
      <details style={{ display: "inline" }}>
        <summary style={{ display: "inline", cursor: "pointer" }}>Window contract</summary>{" "}
        <span style={{ overflowWrap: "anywhere" }}>
          [{from}, {to})
        </span>
      </details>
    </div>
  );
}

function CohortSessionTable({
  cohort,
  ids,
  label,
}: {
  cohort: EsfObservationCohort;
  ids: string[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const allocations = new Map(
    cohort.allocation_sessions.map((session) => [session.session_id, session]),
  );
  return (
    <div style={{ marginTop: 10 }}>
      <button type="button" className="btn-secondary" onClick={() => setOpen((value) => !value)}>
        View sessions ({ids.length}) →
      </button>{" "}
      <span>{label}</span>
      {open && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">State</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {ids.length === 0 ? (
                <tr>
                  <td colSpan={3}>No sessions in this cohort.</td>
                </tr>
              ) : (
                ids.map((id) => {
                  const allocation = allocations.get(id);
                  return (
                    <tr key={id}>
                      <td>
                        <a href={`#/sessions/${encodeURIComponent(id)}`} title={id}>
                          {shortId(id)}
                        </a>
                      </td>
                      <td>
                        <StateChip kind="UNKNOWN" />
                      </td>
                      <td>
                        {allocation === undefined ? (
                          <StateChip kind="UNKNOWN" />
                        ) : (
                          <span>
                            {money(allocation.priced_cost_u)} · {allocation.priced_turn_count}{" "}
                            priced turns · {allocation.unpriced_turn_count} unpriced turns
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function priorWindow(cohort: EsfObservationCohort): { from: string; to: string } | null {
  const from = Date.parse(cohort.from);
  const to = Date.parse(cohort.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return { from: new Date(from - (to - from)).toISOString(), to: cohort.from };
}

function mismatchReason(current: EsfObservationCohort, prior: EsfObservationCohort): string | null {
  if (current.workspace_id !== prior.workspace_id) return "workspace scope differs";
  if (current.cohort_definition_version !== prior.cohort_definition_version)
    return "cohort definition differs";
  if (current.observed_test_recovery.method_version !== prior.observed_test_recovery.method_version)
    return "test-recovery method differs";
  const currentDuration = Date.parse(current.to) - Date.parse(current.from);
  const priorDuration = Date.parse(prior.to) - Date.parse(prior.from);
  if (!Number.isFinite(priorDuration) || priorDuration !== currentDuration)
    return "window duration differs";
  if (prior.to !== current.from) return "window boundary differs";
  return null;
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
          <div>
            <DateRange lead="This data includes entries" from={cohort.from} to={cohort.to} />{" "}
            Resource totals include {cohort.resource.selected_session_count} selected sessions;
            priced and unpriced turns are separate.
          </div>
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
            {cohort.observed_test_recovery.affected_session_ids.length} affected ·{" "}
            {cohort.observed_test_recovery.recovered_session_ids.length ===
            cohort.observed_test_recovery.affected_session_ids.length
              ? `all ${cohort.observed_test_recovery.recovered_session_ids.length} later recovered`
              : `${cohort.observed_test_recovery.recovered_session_ids.length} later recovered`}
          </p>
          <CohortSessionTable
            cohort={cohort}
            label="Affected sessions"
            ids={cohort.observed_test_recovery.affected_session_ids}
          />
          <CohortSessionTable
            cohort={cohort}
            label="Recovered sessions"
            ids={cohort.observed_test_recovery.recovered_session_ids}
          />
          <CohortSessionTable
            cohort={cohort}
            label="No-commit activity sessions"
            ids={cohort.no_commit_activity.session_ids}
          />
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
        if (!active) return;
        const cohort = response.data;
        setState({ status: "ok", cohort, prior: null });
        if (cohort === null) return;
        const prior = priorWindow(cohort);
        if (prior === null) return;
        void fetchEsfObservations(workspaceId, prior)
          .then((priorResponse) => {
            if (active) setState({ status: "ok", cohort, prior: priorResponse.data });
          })
          // Current-window evidence remains useful when a descriptive comparison cannot load.
          .catch(() => {});
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
          <CohortSummary cohort={state.cohort} prior={state.prior} launcher={launcher} />
          <WorkEvidence workspaceId={workspaceId} from={state.cohort.from} to={state.cohort.to} />
        </>
      )}
    </section>
  );
}

function CohortSummary({
  cohort,
  prior,
  launcher,
}: {
  cohort: EsfObservationCohort;
  prior: EsfObservationCohort | null;
  launcher: React.RefObject<HTMLButtonElement>;
}) {
  const { resource, observed_test_recovery: recovery } = cohort;
  const priorMismatch = prior === null ? null : mismatchReason(cohort, prior);
  const comparablePrior = priorMismatch === null ? prior : null;
  if (resource.selected_session_count === 0)
    return <div>No eligible observations in this window.</div>;
  return (
    <>
      <div style={{ marginTop: 0, fontSize: 12, color: "var(--text-muted)" }}>
        <DateRange
          lead={
            cohort.workspace_id === null
              ? "This overview includes data"
              : "This workspace includes data"
          }
          from={cohort.from}
          to={cohort.to}
        />
      </div>
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
            {comparablePrior !== null && (
              <> · prior {money(comparablePrior.resource.priced_cost_u)} priced</>
            )}
          </div>
          <small>
            {resource.unpriced_turn_count} unpriced turns · {resource.live_priced_session_count}{" "}
            priced LIVE sessions
          </small>
        </div>
        <div>
          <strong>Observed workflow</strong>
          <div>
            {recovery.affected_session_ids.length}/
            {recovery.eligible_reconciled_qualifying_tool_session_count} repeated test-failure
            sessions
            {comparablePrior !== null && (
              <>
                {" "}
                · prior {comparablePrior.observed_test_recovery.affected_session_ids.length}/
                {
                  comparablePrior.observed_test_recovery
                    .eligible_reconciled_qualifying_tool_session_count
                }
              </>
            )}
          </div>
          <small>{recovery.recovered_session_ids.length} recovered test sequences</small>
        </div>
      </div>
      {comparablePrior !== null && (
        <p style={{ marginBottom: 0, fontSize: 12 }}>
          Prior-window figures are descriptive, not a delta.
        </p>
      )}
      {priorMismatch !== null && (
        <p style={{ marginBottom: 0, fontSize: 12 }}>
          Prior window not comparable: {priorMismatch}.
        </p>
      )}
      <p style={{ marginBottom: 0, fontSize: 12 }}>
        {cohort.no_commit_activity.session_count} reconciled Bash/edit activity without an observed
        commit
        {comparablePrior !== null && (
          <> · prior {comparablePrior.no_commit_activity.session_count}</>
        )}
        ; {cohort.no_commit_activity.live_session_excluded_count} LIVE sessions excluded from this
        activity cohort.
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
        if (active) setState({ status: "ok", cohort: response.data, prior: null });
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
          <div>
            <DateRange
              lead="This complete session includes data"
              from={cohort.from}
              to={cohort.to}
            />
          </div>
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
                {session.state === "LIVE" ? (
                  "LIVE — excluded from reconciled observation cohort"
                ) : recovered ? (
                  <a href="#session-context-chart">
                    repeated test failures, then an observed later pass
                  </a>
                ) : hasFailure ? (
                  <a href="#session-context-chart">repeated test failures observed</a>
                ) : (
                  "no repeated test-failure sequence observed"
                )}
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
