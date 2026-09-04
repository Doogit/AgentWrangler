import type { ContextComposition } from "../../query/api/context-composition";

function fmtTokens(tokens: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(tokens);
}

export default function ContextCompositionPanel({ data }: { data: ContextComposition | null }) {
  if (data === null || data.observed_turns === 0 || data.inventory_rows === 0) {
    return (
      <section className="card" aria-label="Context composition">
        <h2>Context composition</h2>
        <p className="muted">
          {data?.observed_turns === 0
            ? "No context-bearing turns were observed for this workspace in the last 7 days."
            : "No current CLAUDE.md or MEMORY inventory has been probed for this workspace yet."}
        </p>
      </section>
    );
  }

  const residualShare = data.rows.find((row) => row.key === "session_residual")?.share ?? 0;

  return (
    <section className="card" aria-label="Context composition">
      <h2>Context composition</h2>
      <p className="muted">
        Average context per turn: {fmtTokens(data.observed_context_tokens ?? 0)} tokens (last 7
        days).
      </p>
      {data.rows.map((row) => (
        <div key={row.key} style={{ marginTop: "0.75rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
            <span>
              {row.key === "always_loaded" ? "CLAUDE.md + MEMORY" : "Session history + tools"}
            </span>
            <span>
              {fmtTokens(row.tokens)} tokens
              {row.share === null ? "" : ` (${Math.round(row.share * 100)}%)`}
            </span>
          </div>
          <div className="context-composition-bar" aria-hidden="true">
            <div
              className={`context-composition-segment context-composition-segment-${row.key}`}
              style={{
                width: `${Math.round((row.share ?? 0) * 100)}%`,
              }}
            >
              {(row.share ?? 0) > 0.2 && `${Math.round((row.share ?? 0) * 100)}%`}
            </div>
          </div>
        </div>
      ))}
      {residualShare > 0.7 && (
        <p className="context-composition-interpretation">
          Session history is &gt;70% of context — use /clear more often at task boundaries to reset
          accumulated conversation and reduce per-turn cost.
        </p>
      )}
      <p className="muted" style={{ marginTop: "0.75rem" }}>
        v1 attribution uses estimated current CLAUDE.md and MEMORY token counts only (±5–10%
        tokenizer error). It excludes the system prompt and dynamic MCP schemas. Session history,
        tool outputs, and unattributed fixed overhead remain combined in the residual.
      </p>
    </section>
  );
}
