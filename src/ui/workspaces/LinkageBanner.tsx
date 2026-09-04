/**
 * src/ui/workspaces/LinkageBanner.tsx — Live linkage rate banner.
 *
 * Shows the live per-workspace linkage rate SEPARATELY from the 73%
 * methodology disclosure (plan §6 Q2 — never conflate them).
 */

import type { LinkageRateData } from "../../query/api/outcomes";
import { generateTrailerWriterSnippet } from "../recommendations/prompt-templates";
import Chip from "../shell/Chip";

interface Props {
  data: LinkageRateData | null;
}

function fmtPct(v: number | null): string {
  if (v === null) return "N/A";
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * RI10: opt-in git hook that stamps future commits with an opaque Agent-Session-Id
 * trailer so they link to their PRs. Offered wherever linkage rate is shown.
 */
function TrailerWriterAffordance() {
  const snippet = generateTrailerWriterSnippet();
  return (
    <details className="linkage-trailer-writer" style={{ marginTop: 8 }}>
      <summary>Improve future linkage — install the commit-trailer hook</summary>
      <p className="kpi-off-hint">{snippet.caption}</p>
      <pre data-language={snippet.language}>
        <code>{snippet.text}</code>
      </pre>
    </details>
  );
}

export default function LinkageBanner({ data }: Props) {
  if (data === null) {
    return (
      <div className="banner banner-info" role="note">
        <Chip kind="EXPERIMENTAL" />
        <span style={{ marginLeft: 8 }}>
          Linkage rate unavailable — configure a GitHub token to enable outcome linkage.
        </span>
        <TrailerWriterAffordance />
      </div>
    );
  }

  return (
    <div className="banner banner-info" role="note" aria-label="Linkage rate">
      <Chip kind="EXPERIMENTAL" />
      <span style={{ marginLeft: 8 }}>
        Live linkage rate: <strong>{fmtPct(data.linkage_rate)}</strong> ({data.denominator_n}{" "}
        eligible sessions)
      </span>
      <TrailerWriterAffordance />
    </div>
  );
}
