import { useEffect, useId, useRef, useState } from "react";
import {
  EFFORT_BANDS,
  OUTCOME_STATES,
  REPAIR_BANDS,
  TASK_INTENTS,
  type WorkRecordView,
} from "../../../work-records/types";
import {
  type WorkRecordAction,
  listWorkRecords,
  prepareCreateWorkRecord,
  prepareDeleteWorkRecord,
  prepareWorkRecordAction,
} from "../../api/work-records-client";
import Modal from "../../shell/Modal";
import { WorkAllocationControls } from "./WorkAllocationControls";
import { errorMessage, useWorkOperation } from "./operations";
import "./work-records.css";

export interface WorkRecordControlsProps {
  workspaceId: string;
  sessionId?: string;
  from: string;
  to: string;
  onMutationComplete?: () => void;
}

/** Scope changes remount local drafts and hide results from the previous cohort. */
export function WorkRecordControls(props: WorkRecordControlsProps) {
  return (
    <WorkRecordScope
      key={JSON.stringify([props.workspaceId, props.sessionId, props.from, props.to])}
      {...props}
    />
  );
}
function WorkRecordScope({
  workspaceId,
  sessionId,
  from,
  to,
  onMutationComplete,
}: WorkRecordControlsProps) {
  const [records, setRecords] = useState<WorkRecordView[] | null>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [intent, setIntent] = useState<(typeof TASK_INTENTS)[number]>("UNKNOWN");
  const reload = () => setRefresh((n) => n + 1);
  const complete = () => {
    reload();
    onMutationComplete?.();
  };
  const operation = useWorkOperation(complete, reload);
  useEffect(() => {
    // The refresh counter deliberately invalidates this read after a mutation.
    void refresh;
    let current = true;
    setRecords(null);
    setReadError(null);
    listWorkRecords(workspaceId)
      .then((response) => {
        if (current) setRecords(response.data);
      })
      .catch((error: unknown) => {
        if (current) setReadError(error);
      });
    return () => {
      current = false;
    };
  }, [workspaceId, refresh]);
  const selected = records?.find((record) => record.work_record_id === selectedId);
  return (
    <section className="work-record-controls" aria-label="Local work records">
      <h3>Reported work (optional)</h3>
      <p>
        Workspace {workspaceId}. Selected cohort [{from}, {to}). Records and membership show local
        history, independent of this window.
      </p>
      <p>
        Feedback is user-reported, never inferred from activity. UNREPORTED means no feedback;
        UNKNOWN is an explicit report.
      </p>
      {sessionId && (
        <p>
          Session {sessionId}. Choose any workspace record to attach it; existing membership is
          shown below.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          operation.start(prepareCreateWorkRecord(workspaceId, intent), (result) =>
            setSelectedId(result.data.record.work_record_id),
          );
        }}
      >
        <fieldset disabled={operation.locked}>
          <legend>Create a local work record</legend>
          <EnumSelect
            label="Task intent"
            value={intent}
            options={TASK_INTENTS}
            onChange={setIntent}
          />
          <button className="btn-secondary" type="submit">
            Create work record
          </button>
        </fieldset>
      </form>
      {operation.busy && <output>Saving work record…</output>}
      {operation.notice}
      {readError !== null ? (
        <div role="alert">
          <p>{errorMessage(readError)}</p>
          <button className="btn-secondary" type="button" onClick={reload}>
            Retry records
          </button>
        </div>
      ) : records === null ? (
        <output>Loading work records…</output>
      ) : records.length === 0 ? (
        <p>No local work records.</p>
      ) : (
        <ul>
          {records.map((record) => (
            <li key={record.work_record_id}>
              <button
                className="btn-secondary"
                type="button"
                disabled={operation.locked}
                aria-pressed={record.work_record_id === selectedId}
                onClick={() => setSelectedId(record.work_record_id)}
              >
                {record.work_record_id}
              </button>
              {" — "}
              {record.current.feedback_source === "NONE"
                ? "UNREPORTED"
                : record.current.outcome_state}
              {record.archived_at !== null && " · Archived"}
              {sessionId &&
                record.session_links.some(
                  (link) => link.session_id === sessionId && link.unlinked_at === null,
                ) &&
                " · Current session attached"}
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <RecordDetail
          key={`${selected.work_record_id}:${selected.current_revision_no}`}
          record={selected}
          sessionId={sessionId}
          disabled={operation.locked}
          act={(action) =>
            operation.start(
              prepareWorkRecordAction(
                selected.work_record_id,
                selected.current_revision_no,
                action,
              ),
              () => {},
            )
          }
          remove={() =>
            operation.start(
              prepareDeleteWorkRecord(selected.work_record_id, selected.current_revision_no, true),
              () => setSelectedId(null),
            )
          }
        />
      )}
      <WorkAllocationControls
        workspaceId={workspaceId}
        from={from}
        to={to}
        onMutationComplete={onMutationComplete}
      />
    </section>
  );
}

function RecordDetail({
  record,
  sessionId,
  disabled,
  act,
  remove,
}: {
  record: WorkRecordView;
  sessionId: string | undefined;
  disabled: boolean;
  act: (action: WorkRecordAction) => void;
  remove: () => void;
}) {
  const [intent, setIntent] = useState(record.current.task_intent);
  const [outcome, setOutcome] = useState(record.current.outcome_state);
  const [repair, setRepair] = useState(record.current.repair_band);
  const [effort, setEffort] = useState(record.current.effort_band);
  const [session, setSession] = useState(sessionId ?? "");
  const [confirming, setConfirming] = useState(false);
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);
  const feedback = { outcome_state: outcome, repair_band: repair, effort_band: effort };
  return (
    <div className="work-record-detail">
      <h4 ref={heading} tabIndex={-1}>
        Work record {record.work_record_id}
      </h4>
      <p>
        Revision {record.current_revision_no} · {record.archived_at === null ? "Open" : "Archived"}
      </p>
      <p>
        Feedback:{" "}
        {record.current.feedback_source === "NONE" ? "UNREPORTED" : record.current.outcome_state}.
        Stored outcome: {record.current.outcome_state}. Source: {record.current.feedback_source}.
      </p>
      <p>
        Reported at: {record.current.reported_at ?? "UNREPORTED"}. A terminal report is not activity
        evidence.
      </p>
      <fieldset disabled={disabled}>
        <legend>Edit or close out reported work</legend>
        <EnumSelect
          label="Record task intent"
          value={intent}
          options={TASK_INTENTS}
          onChange={setIntent}
        />
        <EnumSelect
          label="Reported outcome"
          value={outcome}
          options={OUTCOME_STATES}
          onChange={setOutcome}
        />
        <EnumSelect
          label="Repair band"
          value={repair}
          options={REPAIR_BANDS}
          onChange={setRepair}
        />
        <EnumSelect
          label="Effort band"
          value={effort}
          options={EFFORT_BANDS}
          onChange={setEffort}
        />
        <button
          className="btn-secondary"
          type="button"
          onClick={() => act({ action: "edit", fields: { ...feedback, task_intent: intent } })}
        >
          Save feedback
        </button>
        <button
          className="btn-secondary"
          type="button"
          disabled={outcome === "ACTIVE"}
          onClick={() => {
            if (outcome !== "ACTIVE")
              act({ action: "closeout", fields: { ...feedback, outcome_state: outcome } });
          }}
        >
          Close out work record
        </button>
        <button
          className="btn-secondary"
          type="button"
          onClick={() => act({ action: record.archived_at === null ? "archive" : "reopen" })}
        >
          {record.archived_at === null ? "Archive work record" : "Reopen work record"}
        </button>
        <p>Reopen changes archival status only; it does not change reported feedback.</p>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Session membership</legend>
        <label>
          Session ID
          <input
            value={session}
            onChange={(event) => setSession(event.target.value)}
            maxLength={128}
          />
        </label>
        <button
          className="btn-secondary"
          type="button"
          disabled={!session.trim()}
          onClick={() => act({ action: "attach-session", sessionId: session.trim() })}
        >
          Attach session
        </button>
        {record.session_links.length === 0 ? (
          <p>No session membership.</p>
        ) : (
          <ul>
            {record.session_links.map((link) => (
              <li key={`${link.session_id}:${link.linked_revision_no}`}>
                {link.session_id} [{link.linked_at}, {link.unlinked_at ?? "open"})
                {link.unlinked_at === null && (
                  <button
                    className="btn-secondary"
                    type="button"
                    onClick={() => act({ action: "detach-session", sessionId: link.session_id })}
                  >
                    Detach session {link.session_id}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Opaque WORKTREE context</legend>
        <p>
          Creates a local opaque marker. No path, branch, command or external identifier is
          collected.
        </p>
        <button
          className="btn-secondary"
          type="button"
          onClick={() => act({ action: "attach-context" })}
        >
          Attach WORKTREE context
        </button>
        {record.context_refs.length === 0 ? (
          <p>No WORKTREE context.</p>
        ) : (
          <ul>
            {record.context_refs.map((context) => (
              <li key={`${context.context_ref_id}:${context.linked_revision_no}`}>
                {context.context_ref_id} [{context.linked_at}, {context.unlinked_at ?? "open"})
                {context.unlinked_at === null && (
                  <button
                    className="btn-secondary"
                    type="button"
                    onClick={() =>
                      act({ action: "detach-context", contextId: context.context_ref_id })
                    }
                  >
                    Detach context {context.context_ref_id}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <p>
        Permanent deletion removes the record and its feedback. Historical allocations retain
        deletion/source limits and may become incomplete.
      </p>
      <button
        className="btn-secondary"
        type="button"
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        Delete work record…
      </button>
      {confirming && (
        <Modal labelledBy={headingId} onCancel={() => setConfirming(false)}>
          <h4 id={headingId}>Permanently delete work record {record.work_record_id}?</h4>
          <p>This cannot be undone. Historical reports may retain a deleted-source marker.</p>
          <button
            className="btn-secondary"
            type="button"
            ref={cancel}
            onClick={() => setConfirming(false)}
          >
            Cancel deletion
          </button>
          <button
            className="btn-secondary"
            type="button"
            onClick={() => {
              setConfirming(false);
              remove();
            }}
          >
            Confirm permanent deletion
          </button>
        </Modal>
      )}
    </div>
  );
}

function EnumSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
