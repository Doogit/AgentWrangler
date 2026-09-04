/**
 * src/ui/recommendations/DetectorStatusStrip.tsx — per-detector status chips.
 *
 * Renders the live detectors[] list so each detector's current state is shown
 * honestly (matches the mockup footnote).
 */

import type { DetectorStatus } from "../../query/api/recommendations";

const STATUS_CLASS: Record<DetectorStatus["status"], string> = {
  ACTIVE: "detstatus-active",
  INACTIVE: "detstatus-inactive",
  BLOCKED: "detstatus-blocked",
  NOT_EVALUATED: "detstatus-not-evaluated",
};

const DETECTOR_DISPLAY_NAME: Record<string, string> = {
  CTX_ALWAYS_LOADED_OVERSIZE: "CLAUDE.md / memory trim (D1)",
  SESSION_LONG_FULL_CONTEXT: "Marathon sessions (D2)",
  MODEL_MISMATCH: "Model routing (D4)",
  LIMIT_BURN_FORECAST: "Limit warning (D5)",
  TOOL_RESULT_BLOAT: "Tool-result bloat (D6)",
  LOOP_RETRY_WASTE: "Retry / redundant-read (D7)",
  CACHE_WRITE_CHURN: "Cache misses (D8)",
  IDLE_BACKGROUND_SESSION: "Background sessions (D9)",
  CATALOG_FOOTPRINT: "Tool catalog (D10)",
};

function displayName(detector: DetectorStatus): string {
  return DETECTOR_DISPLAY_NAME[detector.name] ?? `${detector.name} (${detector.detector_id})`;
}

export default function DetectorStatusStrip({ detectors }: { detectors: DetectorStatus[] }) {
  return (
    <div className="card" style={{ marginBottom: 13 }}>
      <div className="section-head">
        <h2>Detector coverage</h2>
      </div>
      <ul className="detstatus-list">
        {detectors.map((d) => (
          <li key={d.detector_id} className="detstatus-item">
            {/* biome-ignore lint/a11y/useSemanticElements: status badge uses role="status"; <output> semantics differ */}
            <span className={`chip ${STATUS_CLASS[d.status]}`} role="status" aria-label={d.status}>
              {d.detector_id} · {d.status}
            </span>
            <span className="detstatus-name">{displayName(d)}</span>
            <span className="detstatus-note">{d.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
