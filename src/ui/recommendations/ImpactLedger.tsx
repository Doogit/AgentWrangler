/**
 * src/ui/recommendations/ImpactLedger.tsx — W4 realized-vs-modeled ledger.
 *
 * Renders one row per adopted rec with the honesty rails (design §5):
 *   - MODELED chip is always labeled "MODELED · unverified projection"; the
 *     cap-weighted figure carries the COEFF caveat; never summed with realized.
 *   - OBSERVED chip reads "OBSERVED SINCE ADOPTION" — observed, not causal.
 *   - MEASURING shows a clock + "Probe checking after <date>" — never a zero-like
 *     placeholder.
 *   - MEASURED_NO_EFFECT carries the conservative-measurement note.
 *   - INCONCLUSIVE / confounded_window get their declared banners.
 *   - before_n < 3 ⇒ "Not enough data yet" instead of any figure.
 *
 * Self-fetching via fetchLedger(); three distinct states (loading ≠ error ≠ ok).
 */

import { useEffect, useState } from "react";
import type { EfficiencyHeadroom } from "../../query/api/efficiency-headroom";
import type { LedgerEntry } from "../../query/api/recommendations-ledger";
import type { LedgerView } from "../../query/api/recommendations-ledger";
import type { ApiResponse } from "../../query/envelope";
import { fetchEfficiencyHeadroom, fetchLedger } from "../api/client";
import Chip from "../shell/Chip";
import InfoTip from "../shell/InfoTip";
import { DETECTOR_GROUP_LABELS } from "./RecCard";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; value: ApiResponse<LedgerView> };

type HeadroomState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; value: ApiResponse<EfficiencyHeadroom> };

const MODELED_LABEL = "MODELED · unverified projection";
const OBSERVED_LABEL = "OBSERVED SINCE ADOPTION";
const NO_EFFECT_NOTE =
  "No signal in this window. Realized figures are conservative (direct bytes); modeled figures may be optimistic. A small realized delta does not mean the rec had no value.";
const INCONCLUSIVE_NOTE =
  "Multiple changes in this window; per-source deltas shown individually. Spend-rollup impact cannot be isolated.";
const CONFOUNDED_BANNER =
  "Other recommendations were adopted within 1 day. Changes are attributed per source; total spend impact cannot be isolated.";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function fmtUsdPerWk(microUsd: number): string {
  const dollars = microUsd / 1_000_000;
  const abs = Math.abs(dollars);
  const digits = abs >= 0.1 ? 2 : 3;
  return `–$${abs.toFixed(digits)}/wk`;
}

function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function stateChipText(entry: LedgerEntry): string {
  switch (entry.state) {
    case "MEASURED_EFFECTIVE":
      return "[MEASURED: EFFECTIVE]";
    case "MEASURED_NO_EFFECT":
      return "[MEASURED: NO EFFECT]";
    case "MEASURING":
      return "[MEASURING]";
    default:
      return `[${entry.state}]`;
  }
}

function isRoutingEntry(entry: LedgerEntry): boolean {
  return (
    entry.detector_id === "D4" ||
    entry.target_metric === "ROUTING_ADHERENCE_SCORE" ||
    entry.target_metric === "model_mix_opus_fraction"
  );
}

function isCacheRatioEntry(entry: LedgerEntry): boolean {
  return entry.detector_id === "D8" || entry.target_metric === "cache_read_to_creation_ratio";
}

function hasSparseSample(entry: LedgerEntry, effect: LedgerEntry["effects"][number]): boolean {
  return (
    effect.qualification === "NOT_ENOUGH_DATA" ||
    (entry.detector_id === "D2" && effect.before_n !== null && effect.before_n < 3)
  );
}

/** The realized line for one entry — never a zero-like placeholder while measuring. */
function RealizedLine({ entry }: { entry: LedgerEntry }) {
  const effect = entry.effects[0] ?? null;

  if (entry.state === "ADOPTED" || entry.state === "MEASURING") {
    // Clock + deadline. Deadline comes from the effect row when present,
    // else derived from adopted_at + 14d.
    const deadline =
      effect?.after_to ?? new Date(Date.parse(entry.adopted_at) + 14 * MS_PER_DAY).toISOString();
    return (
      <div className="ledger-row">
        <span className="ledger-key">Realized (observed)</span>
        <span className="ledger-val">
          <span aria-hidden="true">⏱</span> Measuring — Probe checking after {deadline.slice(0, 10)}
        </span>
      </div>
    );
  }

  if (effect !== null && hasSparseSample(entry, effect)) {
    return (
      <div className="ledger-row">
        <span className="ledger-key">Realized (observed)</span>
        <span className="ledger-val">Not enough data yet (need ≥3 observations)</span>
      </div>
    );
  }

  if (effect === null || effect.verdict === null) {
    return (
      <div className="ledger-row">
        <span className="ledger-key">Realized (observed)</span>
        <span className="ledger-val">
          <span aria-hidden="true">⏱</span> Measuring — probe checking after{" "}
          {(effect?.after_to ?? "").slice(0, 10) || "a later probe"}
        </span>
      </div>
    );
  }

  if (effect.verdict === "INCONCLUSIVE") {
    return (
      <div className="ledger-row">
        <span className="ledger-key">Realized (observed)</span>
        <span className="ledger-val">{INCONCLUSIVE_NOTE}</span>
      </div>
    );
  }

  if (effect !== null && isRoutingEntry(entry)) {
    const pointDelta =
      effect.delta_pct !== null
        ? ` (${effect.delta_pct > 0 ? "+" : ""}${effect.delta_pct.toFixed(0)} pts)`
        : "";
    return (
      <div className="ledger-row">
        <span className="ledger-key">Routing adherence</span>
        <span className="ledger-val">
          {effect.before_value ?? "?"}% → {effect.after_value ?? "?"}%{pointDelta}{" "}
          <span className="chip chip-observed">{OBSERVED_LABEL}</span> <Chip kind="DIRECTIONAL" />
        </span>
      </div>
    );
  }

  // D8 cache read/creation ratio (RI9): a directional windowed signal, not tokens.
  if (effect !== null && isCacheRatioEntry(entry)) {
    const pct =
      effect.delta_pct !== null
        ? ` (${effect.delta_pct > 0 ? "+" : ""}${effect.delta_pct.toFixed(1)}%)`
        : "";
    return (
      <div className="ledger-row">
        <span className="ledger-key">Cache read/creation ratio</span>
        <span className="ledger-val">
          {effect.before_value !== null ? effect.before_value.toFixed(2) : "?"} →{" "}
          {effect.after_value !== null ? effect.after_value.toFixed(2) : "?"}
          {pct} <span className="chip chip-observed">{OBSERVED_LABEL}</span>{" "}
          <Chip kind="DIRECTIONAL" />
        </span>
      </div>
    );
  }

  // Windowed floor-context (D2) is direction-only; the direct D1 file-size
  // snapshot is a point measurement, so the DIRECTIONAL chip is D2-only here.
  const directional = entry.detector_id === "D2";
  const deltaText =
    effect.delta_pct !== null
      ? `${effect.after_value !== null ? fmtTokens(Math.round(effect.after_value)) : "?"} tokens (${
          effect.delta_pct > 0 ? "+" : ""
        }${effect.delta_pct.toFixed(1)}%)`
      : "delta not computable";
  return (
    <div className="ledger-row">
      <span className="ledger-key">Realized (observed)</span>
      <span className="ledger-val">
        {deltaText} <span className="chip chip-observed">{OBSERVED_LABEL}</span>
        {directional && (
          <>
            {" "}
            <Chip kind="DIRECTIONAL" />
          </>
        )}
      </span>
    </div>
  );
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const isRoutingAdvisory = isRoutingEntry(entry);
  return (
    <div className="card ledger-entry">
      <div className="ledger-head">
        <strong>
          <span title={entry.detector_id}>
            {DETECTOR_GROUP_LABELS[entry.detector_id] ?? entry.detector_id} · {entry.lever}
          </span>
        </strong>
        <span className="kpi-off-hint">
          Adopted: {entry.adopted_at.slice(0, 10)} {stateChipText(entry)}
        </span>
      </div>

      {entry.confounded_window && (
        <div className="banner banner-warn ledger-banner" role="alert">
          <span>{CONFOUNDED_BANNER}</span>
        </div>
      )}

      {!isRoutingAdvisory && entry.modeled_cap_weighted_u_per_wk !== null && (
        <div className="ledger-row">
          <span className="ledger-key">Modeled (cap-weighted)</span>
          <span className="ledger-val">
            {fmtUsdPerWk(entry.modeled_cap_weighted_u_per_wk)}{" "}
            <Chip kind="MODELED" label={MODELED_LABEL} />{" "}
            <Chip kind="LIST_EQUIV" label="LIST_EQUIV · modeled USD" />
          </span>
        </div>
      )}

      <RealizedLine entry={entry} />

      {isRoutingAdvisory && (
        <p className="kpi-off-hint">
          Advisory: which cap binds is not observable; dollar savings are not asserted.
        </p>
      )}

      {entry.state === "MEASURED_NO_EFFECT" && entry.effects.some((e) => e.verdict !== null) && (
        <p className="kpi-off-hint ledger-note">{NO_EFFECT_NOTE}</p>
      )}

      {entry.effects.length > 1 && (
        <p className="kpi-off-hint">
          Per-source windows:{" "}
          {entry.effects
            .map((e) => `${e.before_to.slice(0, 10)} → ${e.after_to.slice(0, 10)}`)
            .join("; ")}
        </p>
      )}
    </div>
  );
}

function fmtUsdPerWkHeadroom(microUsd: number): string {
  const dollars = microUsd / 1_000_000;
  return `$${dollars.toFixed(2)}/wk`;
}

/** BM2 headroom summary line — a modeled ceiling, never a "$X wasted" claim. */
function HeadroomSummary() {
  const [state, setState] = useState<HeadroomState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchEfficiencyHeadroom()
      .then((v) => {
        if (!cancelled) setState({ status: "ok", value: v });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading" || state.status === "error") return null;

  const data = state.value.data;
  if (data === null) return null;

  const caveat = state.value.meta.qualification.note;
  const pctDisplay =
    data.headroom_pct !== null
      ? `${data.headroom_pct > 1 ? ">100" : (data.headroom_pct * 100).toFixed(0)}% of trailing spend (~${fmtUsdPerWkHeadroom(data.headroom_u_per_wk)})`
      : "—";

  return (
    <div className="headroom-summary ledger-row" data-testid="headroom-summary">
      <span className="ledger-key">
        Modeled headroom <InfoTip label="What is modeled headroom?" content={caveat} />
      </span>
      <span className="ledger-val">
        {pctDisplay !== "—" ? (
          <>
            {pctDisplay} <Chip kind="EXPERIMENTAL" label="MODELED CEILING" />
          </>
        ) : (
          <span className="kpi-off-hint">not enough data to estimate</span>
        )}
        {data.open_rec_count > 0 && (
          <span className="kpi-off-hint">
            {" "}
            · {data.open_rec_count} open {data.open_rec_count === 1 ? "rec" : "recs"}
          </span>
        )}
      </span>
    </div>
  );
}

export default function ImpactLedger() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is an intentional re-fetch trigger
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchLedger()
      .then((v) => {
        if (!cancelled) setState({ status: "ok", value: v });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ status: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (state.status === "loading") {
    return (
      <div className="impact-ledger" aria-busy="true">
        <div className="skeleton" style={{ height: 48 }} />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="impact-ledger">
        <div className="banner banner-error" role="alert">
          <span>Impact Ledger unavailable: {state.message}</span>
        </div>
      </div>
    );
  }

  const view = state.value.data;
  if (view === null || view.entries.length === 0) {
    return (
      <div className="impact-ledger">
        <p className="kpi-off-hint">
          No measured recommendations yet. Adopted recs appear here once the probe measures their
          effect.
        </p>
      </div>
    );
  }

  return (
    <div className="impact-ledger">
      <p className="kpi-fn">
        Cap-weighted estimate uses COEFF={view.cap_read_coeff} (unverified — Anthropic has not
        published a cap coefficient for cache reads).
      </p>
      {view.entries.map((entry) => (
        <LedgerRow key={entry.rec_id} entry={entry} />
      ))}
      <HeadroomSummary />
    </div>
  );
}
