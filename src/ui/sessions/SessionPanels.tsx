import type { ReactNode } from "react";
import type { SessionDiagnosticAnchor } from "../../query/api/diagnostics";
import type { RecommendationCard } from "../../query/api/recommendations";
import type { SessionBreakdown } from "../../query/api/session-breakdown";
import InfoTip from "../shell/InfoTip";
import { SkeletonBlock } from "../shell/Skeleton";

export type PanelState<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; value: T };

// ---------------------------------------------------------------------------
// Label maps (DUI-15 / OV-11 item 29: no internal enum ids in the UI)
// ---------------------------------------------------------------------------

const TOOL_ERROR_CLASS_LABEL: Record<string, string> = {
  NOT_FOUND: "Not found",
  NOT_READ: "Not read first",
  STALE_STRING: "Stale string match",
  PATCH_FAILED: "Patch failed",
  MCP_CONTENT_TOO_LARGE: "MCP content too large",
  MODIFIED_SINCE_READ: "Modified since read",
  MULTI_MATCH: "Multiple matches",
  READ_OUTPUT_TOO_LARGE: "Read output too large",
};

const BASH_COMMAND_FAMILY_LABEL: Record<string, string> = {
  BASH_GIT: "Git",
  BASH_NPM: "npm",
  BASH_PYTHON: "Python",
  BASH_TEST: "Test",
  BASH_BUILD: "Build",
  BASH_OTHER: "Other",
};

function Panel({
  title,
  tip,
  state,
  retry,
  children,
  loadingRows = 2,
  fallbackLink,
}: {
  title: string;
  tip: string;
  state: PanelState<unknown>;
  retry: () => void;
  children: ReactNode;
  loadingRows?: number;
  fallbackLink?: boolean;
}) {
  return (
    <section className="sec session-panel" aria-label={title}>
      <div className="sec-h">
        <h2>
          {title} <InfoTip label={`About ${title}`} content={tip} />
        </h2>
      </div>
      <div className="card">
        {state.status === "loading" && (
          <div className="session-panel-body" aria-busy="true">
            {Array.from({ length: loadingRows }, (_, index) => `skeleton-${index}`).map((key) => (
              <SkeletonBlock key={key} height={28} />
            ))}
          </div>
        )}
        {state.status === "error" && (
          <div className="session-panel-body" role="alert">
            <p>Couldn't load {title.toLowerCase()}</p>
            <button type="button" className="btn-secondary" onClick={retry}>
              Retry
            </button>
            {fallbackLink && <a href="#/recommendations">View all recommendations →</a>}
          </div>
        )}
        {state.status === "ok" && <div className="session-panel-body">{children}</div>}
      </div>
    </section>
  );
}

export function AnomaliesPanel({
  state,
  retry,
}: {
  state: PanelState<SessionDiagnosticAnchor[]>;
  retry: () => void;
}) {
  return (
    <section className="card session-panel" aria-label="Anomalies">
      <details>
        <summary>
          Anomalies{" "}
          <InfoTip
            label="About anomalies"
            content="Structural diagnostic anchors in this session. Open a turn to inspect its context; an anchor is a signal, not a task outcome."
          />
        </summary>
        {state.status === "loading" && (
          <div className="session-panel-body" aria-busy="true">
            <SkeletonBlock height={28} />
            <SkeletonBlock height={28} />
          </div>
        )}
        {state.status === "error" && (
          <div className="session-panel-body" role="alert">
            <p>Couldn't load anomalies</p>
            <button type="button" className="btn-secondary" onClick={retry}>
              Retry
            </button>
          </div>
        )}
        {state.status === "ok" && (
          <div className="session-panel-body">
            {state.value.length === 0 ? (
              <p>No anomalies detected</p>
            ) : (
              <ul className="session-anchor-list">
                {state.value.map((anchor, index) => (
                  <li key={`${anchor.category}-${anchor.timestamp}-${anchor.label}-${index}`}>
                    <span>
                      {anchor.category.replaceAll("_", " ")} · {anchor.label}
                    </span>{" "}
                    {anchor.turn_index !== undefined ? (
                      <a
                        href={`#/sessions/${encodeURIComponent(anchor.session_id)}?turn=${anchor.turn_index}`}
                      >
                        Turn {anchor.turn_index + 1}
                      </a>
                    ) : (
                      <span>Turn unavailable</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </details>
    </section>
  );
}

const COST_COLUMNS = [
  ["input_tokens", "Input"],
  ["output_tokens", "Output"],
  ["cache_read_tokens", "Cache read"],
  ["cache_write_5m", "Cache write 5m"],
  ["cache_write_1h", "Cache write 1h"],
  ["cache_write_other", "Other cache write"],
] as const;

export function CostBreakdownPanel({
  state,
  retry,
}: {
  state: PanelState<SessionBreakdown | null>;
  retry: () => void;
}) {
  const rows = state.status === "ok" ? (state.value?.cost_rows ?? []) : [];
  return (
    <Panel
      title="Cost breakdown"
      tip="Estimated dollars and token categories by model and main or subagent chain. Compare rows to find where this session's spend went."
      state={state}
      retry={retry}
      loadingRows={4}
    >
      {rows.length === 0 ? (
        <p>No turn data for this session</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Chain</th>
                <th>Model</th>
                <th>Turns</th>
                <th>
                  Estimated cost{" "}
                  <InfoTip
                    label="About estimated cost"
                    content="Estimated at public list prices, not a bill. Compare rows to locate spend."
                  />
                </th>
                {COST_COLUMNS.map(([, label]) => (
                  <th key={label}>
                    {label}{" "}
                    <InfoTip
                      label={`About ${label}`}
                      content={`${label} tokens counted for turns in this model and chain. Compare categories to understand context and generation.`}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.model}-${row.is_sidechain}`}>
                  <th>{row.is_sidechain ? "Subagent" : "Main"}</th>
                  <td>{row.model}</td>
                  <td>{row.turn_count.toLocaleString()}</td>
                  <td>${(row.cost_u / 1_000_000).toFixed(2)}</td>
                  {COST_COLUMNS.map(([key]) => (
                    <td key={key}>{row[key].toLocaleString()}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function ToolBreakdownPanel({
  state,
  retry,
  sessionId,
}: {
  state: PanelState<SessionBreakdown | null>;
  retry: () => void;
  sessionId: string;
}) {
  const tools = state.status === "ok" ? (state.value?.tools ?? []) : [];
  return (
    <Panel
      title="Tool breakdown"
      tip="Tool calls, errors, and result sizes for this session. Error classes are structural labels; open the first error turn for context."
      state={state}
      retry={retry}
      loadingRows={3}
    >
      {tools.length === 0 ? (
        <p>No tool calls recorded</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Calls</th>
                <th>Errors</th>
                <th>
                  Result bytes{" "}
                  <InfoTip
                    label="About result bytes"
                    content="Total and largest tool result size in bytes. Large results may grow context."
                  />
                </th>
                <th>First error</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.tool_name}>
                  <th>
                    {tool.first_error_turn_index !== null ? (
                      <a
                        href={`#/sessions/${encodeURIComponent(sessionId)}?turn=${tool.first_error_turn_index}`}
                      >
                        {tool.tool_name}
                      </a>
                    ) : (
                      tool.tool_name
                    )}
                  </th>
                  <td>{tool.calls.toLocaleString()}</td>
                  <td>
                    {tool.errors}
                    {tool.error_breakdown.map((item) => (
                      <span
                        className="session-error-chip"
                        key={`${item.tool_error_class}-${item.bash_command_family}`}
                        title={[item.tool_error_class, item.bash_command_family]
                          .filter((value): value is string => value !== null)
                          .join(" · ")}
                      >
                        {item.tool_error_class !== null
                          ? (TOOL_ERROR_CLASS_LABEL[item.tool_error_class] ?? item.tool_error_class)
                          : "Unclassified"}
                        {item.bash_command_family
                          ? ` · ${BASH_COMMAND_FAMILY_LABEL[item.bash_command_family] ?? item.bash_command_family}`
                          : ""}{" "}
                        ×{item.count}
                      </span>
                    ))}
                  </td>
                  <td>
                    {tool.total_result_bytes.toLocaleString()} total ·{" "}
                    {tool.max_result_bytes.toLocaleString()} max
                  </td>
                  <td>
                    {tool.first_error_at ? new Date(tool.first_error_at).toLocaleString() : "—"}
                  </td>
                  <td>
                    {tool.last_error_at ? new Date(tool.last_error_at).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {tools.every((tool) => tool.errors === 0) && <p>No tool errors</p>}
        </div>
      )}
    </Panel>
  );
}

export function PatternRecommendationsPanel({
  state,
  retry,
}: {
  state: PanelState<RecommendationCard[]>;
  retry: () => void;
}) {
  const recs = state.status === "ok" ? state.value : [];
  return (
    <Panel
      title="Recommendations for this pattern"
      tip="Active recommendations matched to this session's cost driver detectors. Open a recommendation to review its action and evidence."
      state={state}
      retry={retry}
      loadingRows={3}
      fallbackLink
    >
      {recs.length === 0 ? (
        <p>
          No active recommendations for this session's patterns.{" "}
          <a href="#/recommendations">View all recommendations →</a>
        </p>
      ) : (
        <ul className="session-anchor-list">
          {recs.map((rec) => (
            <li key={rec.rec_id}>
              <a href={`#/recommendations?focus=${encodeURIComponent(rec.rec_id)}`}>
                {rec.title ?? rec.lever}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
