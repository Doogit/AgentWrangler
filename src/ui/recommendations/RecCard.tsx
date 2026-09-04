/**
 * src/ui/recommendations/RecCard.tsx — one active recommendation card.
 *
 * Default (collapsed) state: title + per-turn-delta headline +
 * ONE honesty chip + Dismiss/Adopt/Copy prompt/expand buttons. The Evidence
 * table, formula, provenance, target_metric, and caveats are behind a
 * "Show details / methodology" toggle that expands inline.
 *
 * Headline fix: leads with the per-turn delta; modeled savings stay in details.
 * Raw weekly-token counts are dropped from the visible headline to avoid
 * the ~10× overstatement when cache reads (0.1× cap-weight) are shown
 * at full weight.
 *
 * D1 backfire caveat: editing the cached prefix forces one full-price
 * cache WRITE next turn — warn the user in the expanded section.
 */

import { useEffect, useId, useRef, useState } from "react";
import { buildSeededPrompt } from "../../query/api/rec-prompt"; // browser-safe; avoids pulling server-side graph
import type {
  BoundedStep,
  RecommendationCard,
  RecommendationGroup,
} from "../../query/api/recommendations";
import { fetchHookConfig, installHook } from "../api/client";
import { useExperimentalActions } from "../hooks/useExperimentalActions";
import { workspaceLabel } from "../lib/workspace-label";
import Chip from "../shell/Chip";
import InfoTip from "../shell/InfoTip";
import {
  type GeneratedSnippet,
  buildPromptArtifact,
  generateAutocompactSnippet,
  generateModelDefaultSnippet,
  generateSettingsDisableBlock,
  generateSubagentRoutingSnippet,
  scopePromptCaption,
} from "./prompt-templates";
import { sessionIdsForRecommendation } from "./rec-sessions";

/**
 * Self-contained copy-able snippet block (RI8). Used for secondary generated
 * snippets offered alongside the primary one (e.g. the D4 subagent-routing
 * snippet beside the model-default config); owns its own copied state.
 */
function SnippetBlock({ snippet }: { snippet: GeneratedSnippet }) {
  const [copied, setCopied] = useState(false);
  const labelId = useId();
  return (
    <div className="rec-prompt-artifact rec-generated-snippet" data-language={snippet.language}>
      <label className="rec-section-label" htmlFor={labelId}>
        {snippet.caption}
      </label>
      <textarea id={labelId} readOnly value={snippet.text} />
      <button
        type="button"
        className="rec-action-btn"
        onClick={() => {
          void navigator.clipboard.writeText(snippet.text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? "Copied ✓" : "Copy snippet"}
      </button>
    </div>
  );
}

type ApplyUiState =
  | { status: "idle" }
  | { status: "dry_running"; jobId: string }
  | { status: "dry_done"; jobId: string; diffPreview: string }
  | { status: "confirming"; jobId: string; diffPreview: string }
  | { status: "applied"; jobId: string; diffApplied: string | null }
  | { status: "rolled_back" }
  | { status: "failed"; message: string };

type PendingRecommendationAction = "adopt" | "dismiss" | null;

const ACTION_UNDO_WINDOW_MS = 5_000;

interface ApplyJobPayload {
  job_id: string;
  status:
    | "PENDING"
    | "DRY_RUNNING"
    | "DRY_DONE"
    | "CONFIRMING"
    | "APPLIED"
    | "FAILED"
    | "ROLLED_BACK";
  diff_preview: string | null;
  diff_applied: string | null;
  error_msg: string | null;
}

function fmtUsd(u: number): string {
  const usd = u / 1_000_000;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) {
    const decimals = n < 10_000 ? 3 : 0;
    return `${(n / 1_000)
      .toFixed(decimals)
      .replace(/\.0+$/, "")
      .replace(/(\.\d*?)0+$/, "$1")}K`;
  }
  return n.toLocaleString();
}

export const DETECTOR_GROUP_LABELS: Record<string, string> = {
  D1: "CLAUDE.md / memory",
  D2: "Session hygiene",
  D4: "Model routing",
  D5: "Limit warning",
  D6: "Tool-result bloat",
  D7: "Retry / redundant-read",
  D8: "Cache misses",
  D9: "Background sessions",
  D10: "Tool catalog",
};

const CATEGORY_GROUP_FALLBACK: Record<string, string> = {
  CACHE: "Cache misses",
  CONTEXT: "Session hygiene",
  LIMIT: "Limit warning",
  MODEL: "Model routing",
  SESSION_HYGIENE: "Background sessions",
  TOOLING: "Tool-result bloat",
};

function groupLabel(rec: RecommendationCard): string {
  return (
    DETECTOR_GROUP_LABELS[rec.detector_id] ?? CATEGORY_GROUP_FALLBACK[rec.category] ?? rec.category
  );
}

/** Strip absolute path prefixes (Windows/Unix) to produce workspace-relative display strings. */
function stripAbsPath(s: string): string {
  // Windows: C:\Users\foo\... or C:/Users/foo/...
  const win = s.match(/^[A-Za-z]:[/\\](?:[^/\\]+[/\\]){1,4}(.+)$/);
  if (win?.[1]) return win[1];
  // Unix: /Users/foo/... or /home/foo/...
  const unix = s.match(/^\/(?:Users|home)\/[^/]+\/(.+)$/);
  if (unix?.[1]) return unix[1];
  return s;
}

function fmtValue(v: unknown): string {
  if (typeof v === "string") return stripAbsPath(v);
  if (Array.isArray(v))
    return v
      .map((x) =>
        typeof x === "string"
          ? stripAbsPath(x)
          : x !== null && typeof x === "object"
            ? JSON.stringify(x)
            : String(x),
      )
      .join(", ");
  if (typeof v === "number") return v.toLocaleString();
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** ONE claim-kind chip per detector for the collapsed header. */
function claimChipKind(detectorId: string): "PROXY" | "OBS_PROXY" | "EXPERIMENTAL" {
  if (detectorId === "D5") return "PROXY";
  if (detectorId === "D1") return "OBS_PROXY";
  return "EXPERIMENTAL";
}

function evidenceNumber(rec: RecommendationCard, key: string): number | null {
  const value = rec.evidence[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function evidenceString(rec: RecommendationCard, key: string): string | null {
  const value = rec.evidence[key];
  return typeof value === "string" ? value : null;
}

const CAUSE_FACET_LABELS: Record<string, string> = {
  idle_gap: "idle gap",
  model_switch: "model switch",
  session_reopen: "session reopen",
  prefix_config_change: "prefix/config change",
  dynamic_content: "dynamic content",
};

function causeFacetFacts(rec: RecommendationCard): string[] {
  const facets = rec.evidence.cause_facets;
  if (facets === null || typeof facets !== "object" || Array.isArray(facets)) return [];
  return Object.entries(facets as Record<string, unknown>)
    .filter(([, value]) => typeof value === "boolean" || typeof value === "string")
    .map(([key, value]) => `Cause facet — ${CAUSE_FACET_LABELS[key] ?? key}: ${fmtValue(value)}.`);
}

function fmtPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(0)}%`;
}

type ConfidenceTier = {
  label: string;
  className: string;
  tooltip: string;
};

/** Derive the confidence tier label string for a recommendation card. Exported for toolbar use. */
export function confidenceTierLabel(rec: RecommendationCard): string {
  const kind = rec.modeled_formula.kind;
  if (kind === "WARNING") return "WARNING";
  if (kind === "ADVISORY" || rec.detector_id === "D4") return "ADVISORY";
  if (kind === "DIRECTIONAL") return "DIRECTIONAL";
  if (rec.modeled_savings_u_per_wk !== null && rec.detector_id !== "D4") return "MODELED SAVINGS";
  return "DIRECTIONAL";
}

function confidenceTier(rec: RecommendationCard): ConfidenceTier {
  const kind = rec.modeled_formula.kind;
  if (kind === "WARNING") {
    return {
      label: "WARNING",
      className: "rec-confidence-tier--warning",
      tooltip: "Alert, rate-limit headroom burn",
    };
  }
  if (kind === "ADVISORY" || rec.detector_id === "D4") {
    return {
      label: "ADVISORY",
      className: "rec-confidence-tier--advisory",
      tooltip: "Conditional advice, no dollar estimate",
    };
  }
  if (kind === "DIRECTIONAL") {
    return {
      label: "DIRECTIONAL",
      className: "rec-confidence-tier--directional",
      tooltip: "Directional signal only",
    };
  }
  if (rec.modeled_savings_u_per_wk !== null && rec.detector_id !== "D4") {
    return {
      label: "MODELED SAVINGS",
      className: "rec-confidence-tier--modeled",
      tooltip: "Modeled dollar savings from formula with unvalidated assumptions",
    };
  }
  return {
    label: "DIRECTIONAL",
    className: "rec-confidence-tier--directional",
    tooltip: "Directional signal only",
  };
}

function unvalidatedAssumptionNote(rec: RecommendationCard): string | null {
  switch (rec.detector_id) {
    case "D2": {
      const fraction = evidenceNumber(rec, "reduction_fraction");
      return fraction === null
        ? null
        : `Unvalidated assumption: assumes a ${fmtPercent(fraction)} reduction is achievable — a default, not calibrated to your workflow.`;
    }
    case "D8": {
      const fraction = evidenceNumber(rec, "avoidance_fraction");
      return fraction === null
        ? null
        : `Unvalidated assumption: assumes ${fmtPercent(fraction)} of the observed cache re-writes are avoidable — a default, not calibrated.`;
    }
    case "D4": {
      const fraction = rec.modeled_formula.inputs.reduction_fraction;
      return typeof fraction !== "number" || !Number.isFinite(fraction)
        ? null
        : `Unvalidated assumption: assumes ${fmtPercent(fraction)} of flagged Opus turns are Sonnet-movable — a default.`;
    }
    case "D1": {
      const target = evidenceNumber(rec, "source_target");
      const component = evidenceString(rec, "component");
      return target === null || component === null
        ? null
        : `Unvalidated assumption: compares against a default target of ${fmtTokens(target)} tokens for ${component} — not calibrated to your project.`;
    }
    default:
      return null;
  }
}

const FAMILY_RANK_RATIONALE: Record<string, string> = {
  D8: "Cache misses have about 10× more impact than memory trims because each miss re-writes the full context at full cache-write cost",
  D2: "Long, high-context sessions compound token use across every turn, so session hygiene ranks near the top",
  D4: "Model routing only helps when your Opus or all-models cap is actually binding, so it follows the direct waste sources",
  D9: "Background session estimates are directional — useful fan-out and idle work aren't yet separable — so they rank below direct waste sources",
  D1: "Cached reads cost less than fresh writes, so trimming always-loaded context has less impact than fixing cache misses",
};

function rankExplanation(rec: RecommendationCard, rank: number, _displayGroup: string): string {
  const rationale =
    FAMILY_RANK_RATIONALE[rec.detector_id] ??
    "This type of waste has a fixed position in the ranking order";
  return `Why #${rank}: ${rationale}. Items inside this group are ordered by estimated weekly savings.`;
}

function observedFacts(rec: RecommendationCard): string[] {
  switch (rec.detector_id) {
    case "D8": {
      const count = evidenceNumber(rec, "churn_event_count");
      const creation = evidenceNumber(rec, "total_churn_creation_tokens");
      const sessionCap = evidenceNumber(rec, "session_cap_weighted_tokens");
      return [
        count === null
          ? "Cache re-writes followed long idle gaps in this session."
          : `${count.toLocaleString()} cache re-write${count === 1 ? "" : "s"} followed long idle gaps in this session.`,
        creation === null
          ? null
          : `Those re-writes created ${fmtTokens(creation)} cache tokens${sessionCap === null ? "." : ` in a session that used ${fmtTokens(sessionCap)} cap-weighted tokens.`}`,
      ].filter((fact): fact is string => fact !== null);
    }
    case "D2": {
      const count = evidenceNumber(rec, "qualifying_session_count");
      const turnThreshold = evidenceNumber(rec, "turn_count_threshold");
      const contextThreshold = evidenceNumber(rec, "avg_context_threshold");
      const weeklyReads = evidenceNumber(rec, "cache_read_tokens_per_week");
      const rawContextAverage = evidenceNumber(rec, "raw_context_average_tokens_per_turn");
      const rawContextBasis = evidenceString(rec, "raw_context_basis");
      const capWeightedBurn = evidenceNumber(rec, "cap_weighted_burn_tokens_per_week");
      const capWeightedBurnBasis = evidenceString(rec, "cap_weighted_burn_basis");
      const cacheReadExposureTokens = evidenceNumber(rec, "cache_read_exposure_tokens_per_week");
      const cacheReadExposureSpend = evidenceNumber(rec, "cache_read_exposure_spend_u_per_week");
      const cacheReadExposureBasis = evidenceString(rec, "cache_read_exposure_spend_basis");
      return [
        count === null
          ? "Multiple long, high-context sessions crossed the session-hygiene threshold."
          : `${count.toLocaleString()} long, high-context session${count === 1 ? "" : "s"} crossed the session-hygiene threshold.`,
        turnThreshold === null || contextThreshold === null
          ? null
          : `The detector looked for at least ${turnThreshold.toLocaleString()} turns averaging ${fmtTokens(contextThreshold)} context tokens.`,
        weeklyReads === null
          ? null
          : `Those sessions read ${fmtTokens(weeklyReads)} cached tokens this week.`,
        rawContextAverage === null
          ? null
          : `Raw-context average: ${fmtTokens(rawContextAverage)} tokens per turn${rawContextBasis === null ? "." : ` (basis ${rawContextBasis}).`}`,
        capWeightedBurn === null
          ? null
          : `Cap-weighted burn: ${fmtTokens(capWeightedBurn)} tokens this week${capWeightedBurnBasis === null ? "." : ` (basis ${capWeightedBurnBasis}).`}`,
        cacheReadExposureTokens === null || cacheReadExposureSpend === null
          ? null
          : `Cache-read exposure: ${fmtTokens(cacheReadExposureTokens)} tokens plus ${fmtUsd(cacheReadExposureSpend)} list-equivalent USD${cacheReadExposureBasis === null ? "." : ` (basis ${cacheReadExposureBasis}).`}`,
      ].filter((fact): fact is string => fact !== null);
    }
    case "D4": {
      const mismatch = evidenceNumber(rec, "mismatch_turns_per_week");
      const total = evidenceNumber(rec, "total_opus_turns_per_week");
      const fraction = evidenceNumber(rec, "mismatch_fraction");
      return [
        mismatch === null || total === null
          ? "Some Opus turns matched the high-context, low-output routing heuristic."
          : `${mismatch.toLocaleString()} of ${total.toLocaleString()} weekly Opus turns${fraction === null ? "" : ` (${fmtPercent(fraction)})`} matched the high-context, low-output heuristic.`,
        "Transcripts cannot reveal which usage cap is binding; check /usage before changing model routing.",
      ];
    }
    case "D6": {
      const bytes = evidenceNumber(rec, "tool_result_bytes");
      const share = evidenceNumber(rec, "bloat_share");
      const sessionCap = evidenceNumber(rec, "session_cap_weighted_tokens");
      const attributedTool = evidenceString(rec, "attributed_tool");
      const attributedBytes = evidenceNumber(rec, "attributed_result_bytes");
      const carryTurns = evidenceNumber(rec, "carry_turns");
      const carryExposure = evidenceNumber(rec, "carry_exposure_tokens_directional");
      return [
        bytes === null
          ? "Tool-result output crossed the session-level bloat threshold."
          : `${bytes.toLocaleString()} measured tool-result bytes${share === null ? "." : `; after estimating bytes as tokens, the detector puts that output at about ${fmtPercent(share)} of this session${sessionCap === null ? " context." : `'s ${fmtTokens(sessionCap)} cap-weighted context.`}`}`,
        attributedTool === null
          ? "Attribution is session-level: this measurement cannot yet name which tool produced the excess output."
          : `Tool-class attribution: ${attributedTool}.`,
        attributedBytes === null
          ? null
          : `Attributed result bytes: ${attributedBytes.toLocaleString()}.`,
        carryTurns === null ? null : `Carry turns: ${carryTurns.toLocaleString()}.`,
        carryExposure === null
          ? null
          : `Directional carry exposure: ${fmtTokens(carryExposure)} tokens.`,
      ].filter((fact): fact is string => fact !== null);
    }
    case "D7": {
      const coverage = evidenceNumber(rec, "owner_turn_metadata_coverage");
      const covered = evidenceNumber(rec, "owner_turn_metadata_covered_event_count");
      const denominator = evidenceNumber(rec, "owner_turn_metadata_denominator_event_count");
      return [
        "This detector crossed its configured threshold; raw measurements are available in developer diagnostics.",
        coverage === null ? null : `Owner-turn metadata coverage: ${fmtPercent(coverage)}.`,
        covered === null
          ? null
          : `Owner-turn metadata covered events: ${covered.toLocaleString()}.`,
        denominator === null
          ? null
          : `Owner-turn metadata denominator: ${denominator.toLocaleString()} in-window events.`,
      ].filter((fact): fact is string => fact !== null);
    }
    case "D9": {
      const share = evidenceNumber(rec, "sidechain_share");
      const capTokens = evidenceNumber(rec, "sidechain_cap_weighted_tokens");
      const turns = evidenceNumber(rec, "sidechain_turn_count");
      const linkage = evidenceString(rec, "linkage_note");
      return [
        share === null
          ? "Background and sidechain work crossed the directional usage threshold."
          : `Background and sidechain work used ${fmtPercent(share)} of cap-weighted tokens${capTokens === null ? "." : ` (${fmtTokens(capTokens)})`}${turns === null ? "." : ` across ${turns.toLocaleString()} turns.`}`,
        linkage === null
          ? "Much fan-out may be justified, so review before cutting it."
          : "Parent-child linkage is heuristic, and much fan-out may be justified; review before cutting it.",
      ];
    }
    case "D1": {
      const component = evidenceString(rec, "component") ?? "Always-loaded context";
      const source = evidenceNumber(rec, "source_tokens");
      const target = evidenceNumber(rec, "source_target");
      const delta = evidenceNumber(rec, "delta_context_tokens");
      return [
        source === null || target === null
          ? `${component} is larger than its configured always-loaded target.`
          : `${component} measured ${fmtTokens(source)} tokens against a ${fmtTokens(target)} target.`,
        delta === null
          ? null
          : `The proposed trim would remove about ${fmtTokens(delta)} repeated context tokens per turn.`,
      ].filter((fact): fact is string => fact !== null);
    }
    case "D10": {
      const catalog = evidenceNumber(rec, "catalog_tokens");
      const target = evidenceNumber(rec, "catalog_target_tokens");
      const delta = evidenceNumber(rec, "delta_context_tokens");
      const sources = evidenceNumber(rec, "source_count");
      const turns = evidenceNumber(rec, "turns_per_week");
      const effectiveCatalogState = evidenceString(rec, "effective_catalog_state");
      const alwaysLoadCount = evidenceNumber(rec, "always_load_count");
      return [
        catalog === null || target === null
          ? "The tool, plugin, and skill catalog exceeded its configured context target."
          : `The inventory probe estimated ${fmtTokens(catalog)} catalog tokens against a ${fmtTokens(target)} target${delta === null ? "." : `, or ${fmtTokens(delta)} tokens above target.`}`,
        `${sources === null ? "This is a global catalog estimate" : `The global inventory contains ${sources.toLocaleString()} catalog source${sources === 1 ? "" : "s"}`}${turns === null ? "." : `; the weekly projection models repeated reads across ${turns.toLocaleString()} turn${turns === 1 ? "" : "s"}.`}`,
        effectiveCatalogState === null
          ? null
          : `Effective catalog state: ${effectiveCatalogState}.`,
        alwaysLoadCount === null ? null : `Always-load count: ${alwaysLoadCount.toLocaleString()}.`,
      ].filter((fact): fact is string => fact !== null);
    }
    default:
      return [
        "This detector crossed its configured threshold; raw measurements are available in developer diagnostics.",
      ];
  }
}

function impactCaveat(rec: RecommendationCard): string {
  switch (rec.detector_id) {
    case "D8": {
      const fraction = evidenceNumber(rec, "avoidance_fraction");
      return `Projection only — it assumes ${fraction === null ? "some" : fmtPercent(fraction)} of the observed cache re-writes are avoidable.`;
    }
    case "D2": {
      const fraction = evidenceNumber(rec, "reduction_fraction");
      return `Projection only — it assumes a ${fraction === null ? "partial" : fmtPercent(fraction)} reduction in the observed cache-read load.`;
    }
    case "D4":
      return "Conditional advisory — no dollar estimate is shown because routing only helps when the all-models or Opus cap is binding.";
    case "D6":
      return "Directional signal only — bytes are converted with an unvalidated 4 B/token heuristic; this is structural exposure, not an avoidable-token or USD savings estimate.";
    case "D9":
      return "Directional signal only — no dollar estimate is shown because useful fan-out and avoidable background work are not yet separable.";
    case "D7":
      return "Directional exposure only — no dollar estimate is shown because structural retry signals do not prove how much work was avoidable.";
    case "D1":
      return "Projection only — steady cache reads are priced below fresh writes, and the first turn after editing the cached prefix can cost more.";
    case "D10": {
      const delta = evidenceNumber(rec, "delta_context_tokens");
      return `Projection only — the catalog threshold is unvalidated, and the estimate assumes ${delta === null ? "excess catalog context" : `${fmtTokens(delta)} excess catalog tokens`} can be removed from repeated reads; this is not measured or achieved savings.`;
    }
    default:
      return "Modeled projection — not measured, achieved, or billed savings.";
  }
}

function successMeasure(rec: RecommendationCard): string {
  switch (rec.detector_id) {
    case "D8":
      return "Compare the next 7 days with this window: look for fewer cache-creation spikes after idle gaps and a higher cache-read-to-creation ratio.";
    case "D2":
      return "Re-check after 7 days: average context per turn should fall without more retries, rework, or failed outcomes.";
    case "D4":
      return "Only if /usage confirms the all-models or Opus cap is binding, re-check this workspace's Opus share after 7 days.";
    case "D6":
      return "Re-run the detector on later sessions: tool-result bytes and share should fall without more failed tool calls, retries, or missing context.";
    case "D9":
      return "Re-check after 7 days: background/sidechain share should fall after justified fan-out is preserved and idle work is removed.";
    case "D1":
      return "Run the next inventory probe and compare the always-loaded memory size, then confirm average context per turn falls without lost guidance.";
    case "D10": {
      const catalog = evidenceNumber(rec, "catalog_tokens");
      const target = evidenceNumber(rec, "catalog_target_tokens");
      return `Run the next inventory probe: the tool, plugin, and skill catalog estimate should move${catalog === null ? "" : ` from ${fmtTokens(catalog)}`}${target === null ? " below its target" : ` toward ${fmtTokens(target)}`} while required tools remain available.`;
    }
    default:
      return "Re-run the detector after 7 days and compare its target signal with this window.";
  }
}

/** Derive a human-readable display string for a BoundedStep. */
function stepDisplay(step: BoundedStep): string {
  switch (step.kind) {
    case "trim":
      return `Trim ${step.target}${step.max_lines !== undefined ? ` (max ${step.max_lines} lines)` : ""}`;
    case "disable_plugin":
      return `Disable plugin: ${step.plugin_id}`;
    case "route_model":
      return `Route ${step.from} → ${step.to}`;
    case "session_boundary":
      return "Insert session boundary (/clear)";
    case "generic":
      return step.description;
  }
}

/**
 * Per-detector primary-action routing (RV4). Behavioral detectors lead with the
 * shipped hook; idle/limit detectors route to their Settings panel; artifact
 * detectors keep the copy-prompt primary.
 */
type RecRoute = "hook" | "settings-idle" | "settings-calibrate" | "copy";

function recRoute(detectorId: string): RecRoute {
  if (detectorId === "D2" || detectorId === "D8" || detectorId === "D7") return "hook";
  if (detectorId === "D9") return "settings-idle";
  if (detectorId === "D5") return "settings-calibrate";
  return "copy";
}

// Module-level cache of the context-budget hook's install state, mirroring
// fetchSessionToken: one GET /api/hook-config per page load, shared across cards.
let cachedHookInstalled: boolean | null = null;

async function fetchHookInstalled(): Promise<boolean> {
  if (cachedHookInstalled !== null) return cachedHookInstalled;
  try {
    const res = await fetchHookConfig();
    cachedHookInstalled = res.data?.installed ?? false;
  } catch {
    cachedHookInstalled = false;
  }
  return cachedHookInstalled;
}

/** Test-only: reset the module-level install-state cache between renders. */
export function __resetHookInstallCache(): void {
  cachedHookInstalled = null;
}

/** Primary action for behavioral (D2/D8/D7) cards: install the shipped hook. */
function HookInstallButton() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchHookInstalled().then((value) => {
      if (active) setInstalled(value);
    });
    return () => {
      active = false;
    };
  }, []);

  async function onInstall() {
    setBusy(true);
    setError(null);
    setInstalled(true);
    try {
      await installHook();
      cachedHookInstalled = true;
    } catch (e: unknown) {
      setInstalled(false);
      cachedHookInstalled = false;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (installed === true) {
    return (
      <button type="button" className="rec-action-btn rec-action-btn--primary" disabled>
        Installed ✓
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        className="rec-action-btn rec-action-btn--primary"
        onClick={() => void onInstall()}
        disabled={busy}
      >
        {busy ? "Installing…" : "Install hook"}
      </button>
      {error !== null && (
        <span className="rec-apply-status rec-apply-status--error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function isStartupFailure(message: string): boolean {
  return /(?:^|\s)spawn(?:\s|$)/i.test(message.trim());
}

function inferWorkspaceCwd(fileRef: string | null): string | null {
  if (fileRef === null) return null;
  // Assisted-apply-eligible recs target the project CLAUDE.md, which the context
  // probe records at <repo_path>/CLAUDE.md (repo root, no .claude/ segment).
  // Accept that shape and the legacy .claude/CLAUDE.md layout.
  const cwd = fileRef.replace(/[\\/](?:\.claude[\\/])?CLAUDE\.md$/i, "");
  if (cwd === fileRef) return null;
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(cwd)) return null;
  return cwd;
}

function canAssistedApplyForRec(rec: RecommendationCard): boolean {
  return (
    rec.state === "PROPOSED" &&
    rec.file_ref !== null &&
    rec.scope_workspace_id !== null &&
    inferWorkspaceCwd(rec.file_ref) !== null
  );
}

let cachedSessionToken: string | null = null;

async function fetchSessionToken(): Promise<string> {
  if (cachedSessionToken !== null) return cachedSessionToken;
  try {
    const res = await fetch("/api/token");
    if (!res.ok) {
      cachedSessionToken = "";
      return cachedSessionToken;
    }
    const data = (await res.json()) as { token?: string };
    cachedSessionToken = typeof data.token === "string" ? data.token : "";
    return cachedSessionToken;
  } catch {
    cachedSessionToken = "";
    return cachedSessionToken;
  }
}

async function responseText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `${res.status}`;
  } catch {
    return res.text();
  }
}

/** RV6 highlight banner shown on the focused (deep-linked) card. */
function FocusHighlightBanner({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <output className="rec-focus-banner">
      <span className="rec-focus-banner-label">Linked from Overview — top recommendation</span>
      <button
        type="button"
        className="rec-focus-dismiss"
        aria-label="Dismiss highlight"
        onClick={onDismiss}
      >
        ✕
      </button>
    </output>
  );
}

/**
 * Scope badge — ONE per rendered card.
 * Global recs (scope_workspace_id === null): violet "global · ×N workspaces" badge.
 * Workspace recs: blue "workspace · <label>" badge.
 */
function ScopeBadge({ rec }: { rec: RecommendationCard }) {
  if (rec.cross_workspace) {
    const label =
      rec.workspace_multiplier !== null
        ? `global · ×${rec.workspace_multiplier} workspaces`
        : "global";
    return <span className="rec-scope-badge rec-scope-badge--global">{label}</span>;
  }
  const wsId = rec.scope_workspace_id;
  const label = wsId !== null ? workspaceLabel({ workspace_id: wsId }) : "";
  return <span className="rec-scope-badge rec-scope-badge--workspace">workspace · {label}</span>;
}

/** Best-effort scroll a focused card into view; jsdom lacks scrollIntoView. */
function scrollFocusedIntoView(el: HTMLElement | null): void {
  if (el === null || typeof el.scrollIntoView !== "function") return;
  try {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch {
    // jsdom: scrollIntoView is not implemented — highlight/expand still apply.
  }
}

interface SingleRecCardProps {
  rec: RecommendationCard;
  /** Cross-list rank (1 = highest-leverage). Optional; defaults to 1 for standalone use. */
  rank?: number;
  /** True for the #1 ranked card — renders flagship badge + rationale. */
  isFlagship?: boolean;
  /** Render as a member row inside a detector group rather than a standalone card. */
  grouped?: boolean;
  /** Show affected session links in the member row. */
  showSessionRows?: boolean;
  /** RV6 deep-link target: when it equals this rec's id, auto-expand (and, when standalone, highlight). */
  focusRecId?: string | null;
  /** Clear the focus deep-link when the user dismisses the highlight. */
  onDismissFocus?: () => void;
  onDismiss?: (recId: string) => void;
  onAdopt?: (recId: string) => void;
}

function SingleRecCard({
  rec,
  rank = 1,
  isFlagship,
  grouped = false,
  showSessionRows = false,
  focusRecId = null,
  onDismissFocus,
  onDismiss,
  onAdopt,
}: SingleRecCardProps) {
  const experimental = useExperimentalActions();
  const focused = focusRecId !== null && focusRecId === rec.rec_id;
  const [expanded, setExpanded] = useState(focused);
  const cardRef = useRef<HTMLDivElement>(null);

  // Auto-expand + scroll when this card becomes the deep-link target (RV6).
  // Grouped members expand here; the group card owns scroll/highlight.
  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    if (!grouped) scrollFocusedIntoView(cardRef.current);
  }, [focused, grouped]);
  const [collapsedChipsExpanded, setCollapsedChipsExpanded] = useState(false);
  const [artifactCopied, setArtifactCopied] = useState(false);
  const [guidedShown, setGuidedShown] = useState(false);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [applyState, setApplyState] = useState<ApplyUiState>({ status: "idle" });
  const [openTerminalMsg, setOpenTerminalMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [pendingAction, setPendingAction] = useState<PendingRecommendationAction>(null);
  const [pendingTimeoutId, setPendingTimeoutId] = useState<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailsId = useId();
  const chipOverflowId = useId();
  const promptArtifactId = useId();
  const snippetLabelId = useId();

  const f = rec.modeled_formula;
  const hasSavings = rec.modeled_savings_u_per_wk !== null;
  const isD1 = rec.detector_id === "D1";
  const isD4 = rec.detector_id === "D4";
  const tier = confidenceTier(rec);
  const assumptionNote = unvalidatedAssumptionNote(rec);
  const hasVisibleSavings = hasSavings && !isD4;
  // Keep the complete chip set intact. The collapsed row elevates the confidence
  // tier and one claim chip, while the remaining explanatory chips are disclosed
  // inline rather than removed. The details view below intentionally keeps its
  // existing rendering unchanged.
  const overflowChips = hasVisibleSavings
    ? [
        <Chip key="modeled" kind="MODELED" />,
        <Chip key="list-equiv" kind="LIST_EQUIV" label="LIST_EQUIV · modeled USD" />,
      ]
    : [];
  const isAdopted = rec.state !== "PROPOSED" || pendingAction === "adopt";
  const displayGroup = groupLabel(rec);
  const workspaceCwd = inferWorkspaceCwd(rec.file_ref);
  const canAssistedApply = canAssistedApplyForRec(rec);
  const causeFacets = causeFacetFacts(rec);
  const observationFacts = observedFacts(rec);
  const promptArtifact = buildPromptArtifact(rec);
  // Open in Claude Code ↗ (O11 Option B) reaches every workspace-scoped rec that
  // has a seedable prompt — the daemon resolves the cwd from the workspace, so
  // reach is not limited to file-ref recs the way headless assisted-apply is.
  const canOpenTerminal =
    rec.state === "PROPOSED" && rec.scope_workspace_id !== null && promptArtifact !== null;
  const route = recRoute(rec.detector_id);
  const generatedSnippet: GeneratedSnippet | null =
    generateSettingsDisableBlock(rec) ??
    generateModelDefaultSnippet(rec) ??
    generateAutocompactSnippet(rec);
  // Secondary snippet offered alongside the primary (RI8): D4 subagent routing.
  const generatedSnippet2: GeneratedSnippet | null = generateSubagentRoutingSnippet(rec);
  const visibleObservationFacts = observationFacts.slice(0, 2);
  const diagnosticObservationFacts = observationFacts.slice(2);

  // Per-turn delta: from evidence.delta_context_tokens (present on D1/CONTEXT recs)
  const deltaCtx =
    typeof rec.evidence.delta_context_tokens === "number"
      ? rec.evidence.delta_context_tokens
      : null;
  const sessionIds = sessionIdsForRecommendation(rec);

  // Collapsed headline: per-turn delta as the primary anchor.
  // Raw weekly-token count is intentionally dropped to avoid the 10× overstatement.
  const turnAnchor = deltaCtx !== null ? `-${fmtTokens(deltaCtx)} tokens/turn` : null;
  const headlineText = isD4
    ? "If your Opus or all-models cap is binding (check /usage) — these turns are Sonnet-movable."
    : (turnAnchor ?? "Directional — no modeled savings");

  function handleAnalyze() {
    const prompt = buildSeededPrompt(rec);
    void navigator.clipboard.writeText(prompt);
  }

  function handleCopyPromptArtifact() {
    if (promptArtifact === null) return;
    void navigator.clipboard.writeText(promptArtifact.text).then(() => {
      setArtifactCopied(true);
      setTimeout(() => setArtifactCopied(false), 2000);
    });
  }

  function handleCopySnippet() {
    if (generatedSnippet === null) return;
    void navigator.clipboard.writeText(generatedSnippet.text).then(() => {
      setSnippetCopied(true);
      setTimeout(() => setSnippetCopied(false), 2000);
    });
  }

  function clearPendingAction() {
    if (pendingTimeoutRef.current !== null) {
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }
    setPendingTimeoutId(null);
    setPendingAction(null);
  }

  function scheduleAction(action: Exclude<PendingRecommendationAction, null>) {
    const commit = action === "adopt" ? onAdopt : onDismiss;
    if (commit === undefined || pendingAction !== null) return;

    setPendingAction(action);
    const timeoutId = setTimeout(() => {
      pendingTimeoutRef.current = null;
      setPendingTimeoutId(null);
      setPendingAction(null);
      commit(rec.rec_id);
    }, ACTION_UNDO_WINDOW_MS);
    pendingTimeoutRef.current = timeoutId;
    setPendingTimeoutId(timeoutId);
  }

  useEffect(() => {
    return () => {
      if (pendingTimeoutRef.current !== null) clearTimeout(pendingTimeoutRef.current);
    };
  }, []);

  async function pollJob(jobId: string, previousPreview: string | null = null): Promise<void> {
    for (let i = 0; i < 90; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
      const res = await fetch(`/api/recommendations/jobs/${encodeURIComponent(jobId)}`);
      if (!res.ok) throw new Error(await responseText(res));
      const body = (await res.json()) as { data?: ApplyJobPayload };
      const job = body.data;
      if (job === undefined) throw new Error("Malformed job response");
      if (job.status === "DRY_DONE") {
        setApplyState({
          status: "dry_done",
          jobId,
          diffPreview: job.diff_preview ?? "Dry run completed with no preview output.",
        });
        return;
      }
      if (job.status === "APPLIED") {
        setApplyState({ status: "applied", jobId, diffApplied: job.diff_applied });
        return;
      }
      if (job.status === "ROLLED_BACK") {
        setApplyState({ status: "rolled_back" });
        return;
      }
      if (job.status === "FAILED") {
        setApplyState({ status: "failed", message: job.error_msg ?? "Apply job failed" });
        return;
      }
      if (job.status === "CONFIRMING" && previousPreview !== null) {
        setApplyState({ status: "confirming", jobId, diffPreview: previousPreview });
      }
    }
    throw new Error("Timed out waiting for apply job");
  }

  function handleAssistedApply() {
    if (!canAssistedApply || workspaceCwd === null) return;
    setApplyState({ status: "dry_running", jobId: "" });
    void fetchSessionToken()
      .then((token) =>
        fetch(`/api/recommendations/${encodeURIComponent(rec.rec_id)}/apply`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-AgentWrangler-Token": token } : {}),
          },
          body: JSON.stringify({ workspace_cwd: workspaceCwd }),
        }),
      )
      .then(async (res) => {
        if (!res.ok) throw new Error(await responseText(res));
        const body = (await res.json()) as { data?: { job_id?: string } };
        const jobId = body.data?.job_id;
        if (typeof jobId !== "string") throw new Error("Malformed apply response");
        setApplyState({ status: "dry_running", jobId });
        await pollJob(jobId);
      })
      .catch((e: unknown) => {
        setApplyState({ status: "failed", message: e instanceof Error ? e.message : String(e) });
      });
  }

  function handleOpenTerminal() {
    if (!canOpenTerminal || promptArtifact === null || rec.scope_workspace_id === null) return;
    setOpenTerminalMsg(null);
    const workspaceId = rec.scope_workspace_id;
    void fetchSessionToken()
      .then((token) =>
        fetch(`/api/recommendations/${encodeURIComponent(rec.rec_id)}/open-terminal`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-AgentWrangler-Token": token } : {}),
          },
          body: JSON.stringify({ prompt: promptArtifact.text }),
        }),
      )
      .then(async (res) => {
        const body = (await res.json()) as { launched?: boolean; reason?: string };
        if (res.ok && body.launched === true) {
          setOpenTerminalMsg({
            ok: true,
            text: `Opened a terminal in ${workspaceLabel({ workspace_id: workspaceId })}.`,
          });
        } else {
          setOpenTerminalMsg({
            ok: false,
            text: body.reason ?? "No terminal found — Copy prompt instead.",
          });
        }
      })
      .catch(() => {
        setOpenTerminalMsg({ ok: false, text: "No terminal found — Copy prompt instead." });
      });
  }

  function handleConfirmApply() {
    if (applyState.status !== "dry_done") return;
    const { jobId, diffPreview } = applyState;
    setApplyState({ status: "confirming", jobId, diffPreview });
    void fetchSessionToken()
      .then((token) =>
        fetch(`/api/recommendations/jobs/${encodeURIComponent(jobId)}/confirm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-AgentWrangler-Token": token } : {}),
          },
          body: JSON.stringify({}),
        }),
      )
      .then(async (res) => {
        if (!res.ok) throw new Error(await responseText(res));
        await pollJob(jobId, diffPreview);
      })
      .catch((e: unknown) => {
        setApplyState({ status: "failed", message: e instanceof Error ? e.message : String(e) });
      });
  }

  function handleRollbackApply() {
    if (applyState.status !== "applied") return;
    const { jobId } = applyState;
    void fetchSessionToken()
      .then((token) =>
        fetch(`/api/recommendations/jobs/${encodeURIComponent(jobId)}/rollback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-AgentWrangler-Token": token } : {}),
          },
          body: JSON.stringify({}),
        }),
      )
      .then(async (res) => {
        if (!res.ok) throw new Error(await responseText(res));
        setApplyState({ status: "rolled_back" });
      })
      .catch((e: unknown) => {
        setApplyState({ status: "failed", message: e instanceof Error ? e.message : String(e) });
      });
  }

  const rootClass = grouped ? "rec-session-row" : "card rec-card";
  const highlightClass = focused && !grouped ? " rec-focus-highlight" : "";

  return (
    <div ref={cardRef} className={`${rootClass}${highlightClass}`} style={{ marginBottom: 13 }}>
      {focused && !grouped && (
        <FocusHighlightBanner
          {...(onDismissFocus === undefined ? {} : { onDismiss: onDismissFocus })}
        />
      )}
      {/* Flagship banner for the #1 ranked card */}
      {!grouped && isFlagship && (
        <div className="rec-flagship-banner">
          <span className="rec-flagship-badge">HIGHEST-LEVERAGE</span>
          <span className="rec-flagship-rationale">
            Cache misses have ~10× the impact of memory trims.
          </span>
        </div>
      )}

      {/* Collapsed row — always visible */}
      <div className="rec-collapsed-row">
        <div className="rec-collapsed-main">
          <div className="rec-header-row">
            {!grouped && <span className="rec-rank-badge">#{rank}</span>}
            <h3 className="rec-title">{rec.title ?? rec.lever}</h3>
            <span className="rec-category-chip">{displayGroup}</span>
            <ScopeBadge rec={rec} />
            {isAdopted && (
              <span className="rec-adopted-pill">
                {pendingAction === "adopt" ? "Adopted — Undo" : "Adopted"}
              </span>
            )}
            {pendingAction === "dismiss" && (
              <span className="rec-pending-action-pill">Dismissed — Undo</span>
            )}
          </div>
          <div className="rec-headline">
            <span className="rec-headline-text">{headlineText}</span>
            <span className="rec-chip-row" aria-label="Recommendation claim indicators">
              <InfoTip
                label="What the claim chips mean"
                content="How the number was derived — directly measured (EXACT) or estimated (PROXY/OBS PROXY). Weight a recommendation by how solid its claim is."
              />
              <span
                className={`rec-confidence-tier ${tier.className}`}
                title={tier.tooltip}
                aria-label={tier.tooltip}
              >
                {tier.label}
              </span>
              <Chip kind={claimChipKind(rec.detector_id)} />
              {collapsedChipsExpanded && (
                <span id={chipOverflowId} className="rec-chip-overflow">
                  {overflowChips}
                </span>
              )}
              {overflowChips.length > 0 && (
                <button
                  type="button"
                  className="rec-chip-expander"
                  data-chip-expander
                  aria-controls={collapsedChipsExpanded ? chipOverflowId : undefined}
                  aria-expanded={collapsedChipsExpanded}
                  onClick={() => setCollapsedChipsExpanded((isOpen) => !isOpen)}
                >
                  {collapsedChipsExpanded ? "−" : "+"}
                  {overflowChips.length}
                </button>
              )}
            </span>
          </div>
          {showSessionRows && sessionIds.length > 0 && (
            <ul className="rec-session-links" aria-label="Affected sessions">
              {sessionIds.map((sessionId) => (
                <li key={sessionId}>
                  <span className="rec-session-label">Session</span>{" "}
                  <a href={`#/sessions/${encodeURIComponent(sessionId)}`}>{sessionId}</a>
                </li>
              ))}
            </ul>
          )}
          {/* D1 secondary-lever label (taxonomy R9 / D8 design §9.7):
              always visible in collapsed state so the user sees the framing before acting. */}
          {!grouped && isD1 && (
            <p className="rec-d1-secondary-lever">
              This is the smallest lever — the one everyone blames. Cache misses (D8) have ~10× more
              impact on the same session.
            </p>
          )}
        </div>
        <div className="rec-actions">
          <button
            type="button"
            className="rec-action-btn rec-action-btn--ghost"
            onClick={() => scheduleAction("dismiss")}
            disabled={!onDismiss || pendingAction !== null}
          >
            Dismiss
          </button>
          <button
            type="button"
            className="rec-action-btn"
            title="Marks this adopted and starts impact tracking — changes no files."
            onClick={() => scheduleAction("adopt")}
            disabled={!onAdopt || pendingAction !== null}
          >
            Adopt
          </button>
          {experimental && canOpenTerminal && (
            <button
              type="button"
              className="rec-action-btn rec-action-btn--primary"
              title="Opens your terminal in this workspace running an interactive Claude Code session seeded with the prompt. The daemon changes no files."
              onClick={handleOpenTerminal}
            >
              Open in Claude Code ↗
            </button>
          )}
          <button
            type="button"
            className="rec-action-btn rec-expand-btn"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? "Hide details ▲" : "Show details ▼"}
          </button>
        </div>
        {!grouped && route === "hook" && (
          <div className="rec-primary-action">
            <HookInstallButton />
            {promptArtifact !== null && (
              <div className="rec-guided-prompt">
                <button
                  type="button"
                  className="rec-action-btn rec-guided-toggle"
                  aria-expanded={guidedShown}
                  onClick={() => setGuidedShown((s) => !s)}
                >
                  {guidedShown ? "Hide guided prompt" : "Show guided prompt"}
                </button>
                {guidedShown && (
                  <div className="rec-prompt-artifact" data-flavor={promptArtifact.flavor}>
                    <label className="rec-section-label" htmlFor={promptArtifactId}>
                      Copy prompt
                    </label>
                    <textarea id={promptArtifactId} readOnly value={promptArtifact.text} />
                    <button
                      type="button"
                      className="rec-action-btn"
                      onClick={handleCopyPromptArtifact}
                    >
                      {artifactCopied ? "Copied ✓" : "Copy prompt"}
                    </button>
                    <span className="rec-prompt-scope-caption">{scopePromptCaption(rec)}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {!grouped && route === "settings-idle" && (
          <div className="rec-primary-action">
            <a className="rec-action-btn rec-action-btn--primary" href="#/settings">
              Review idle sessions
            </a>
          </div>
        )}
        {!grouped && route === "settings-calibrate" && (
          <div className="rec-primary-action">
            <a className="rec-action-btn rec-action-btn--primary" href="#/settings">
              Calibrate budget hook
            </a>
          </div>
        )}
        {!grouped && route === "copy" && promptArtifact !== null && (
          <div className="rec-prompt-artifact" data-flavor={promptArtifact.flavor}>
            <label className="rec-section-label" htmlFor={promptArtifactId}>
              Copy prompt
            </label>
            <textarea id={promptArtifactId} readOnly value={promptArtifact.text} />
            <button
              type="button"
              className="rec-action-btn rec-action-btn--primary"
              onClick={handleCopyPromptArtifact}
            >
              {artifactCopied ? "Copied ✓" : "Copy prompt"}
            </button>
            <span className="rec-prompt-scope-caption">{scopePromptCaption(rec)}</span>
          </div>
        )}
        {!grouped && generatedSnippet && (
          <div
            className="rec-prompt-artifact rec-generated-snippet"
            data-language={generatedSnippet.language}
          >
            <label className="rec-section-label" htmlFor={snippetLabelId}>
              {generatedSnippet.caption}
            </label>
            <textarea id={snippetLabelId} readOnly value={generatedSnippet.text} />
            <button type="button" className="rec-action-btn" onClick={handleCopySnippet}>
              {snippetCopied ? "Copied ✓" : "Copy snippet"}
            </button>
          </div>
        )}
        {!grouped && generatedSnippet2 && <SnippetBlock snippet={generatedSnippet2} />}
        {!grouped && route === "copy" && (
          <p className="rec-actions-hint">
            {experimental && canOpenTerminal
              ? "Open in Claude Code launches your terminal in this workspace with the prompt loaded — you review and drive every edit."
              : "Applying is manual — copy the prompt and run it in your local Claude Code CLI."}
          </p>
        )}
        {pendingAction !== null && pendingTimeoutId !== null && (
          <output className="rec-action-toast">
            <span>{pendingAction === "adopt" ? "Adopted — Undo" : "Dismissed — Undo"}</span>
            <button type="button" className="rec-action-toast-undo" onClick={clearPendingAction}>
              Undo
            </button>
          </output>
        )}
        {openTerminalMsg !== null && (
          <output
            className={`rec-apply-status${openTerminalMsg.ok ? "" : " rec-apply-status--error"}`}
            {...(openTerminalMsg.ok ? {} : { role: "alert" as const })}
          >
            {openTerminalMsg.text}
          </output>
        )}
        {experimental && applyState.status === "dry_done" && (
          <div className="rec-apply-panel">
            <div className="rec-section-label">Dry-run preview</div>
            <pre className="rec-apply-preview">{applyState.diffPreview}</pre>
            <div className="rec-actions-secondary">
              <button
                type="button"
                className="rec-action-btn rec-action-btn--primary"
                onClick={handleConfirmApply}
              >
                Confirm apply
              </button>
            </div>
          </div>
        )}
        {experimental && applyState.status === "confirming" && (
          <div className="rec-apply-panel">
            <div className="rec-section-label">Applying</div>
            <p className="kpi-off-hint">Claude Code is applying the confirmed edit.</p>
          </div>
        )}
        {experimental && applyState.status === "applied" && (
          <div className="rec-apply-panel">
            <div className="rec-section-label">Applied</div>
            {applyState.diffApplied !== null && (
              <pre className="rec-apply-preview">{applyState.diffApplied}</pre>
            )}
            <div className="rec-actions-secondary">
              <button type="button" className="rec-action-btn" onClick={handleRollbackApply}>
                Roll back
              </button>
            </div>
          </div>
        )}
        {experimental && applyState.status === "rolled_back" && (
          <p className="rec-apply-status">Rolled back to the pre-apply backup.</p>
        )}
        {experimental && applyState.status === "failed" && (
          <div className="rec-apply-panel" role="alert">
            <div className="rec-section-label">
              {isStartupFailure(applyState.message)
                ? "Apply could not start"
                : "Apply did not complete"}
            </div>
            <p className="rec-apply-status rec-apply-status--error">
              {isStartupFailure(applyState.message)
                ? "Couldn't start the local Claude Code CLI — use Copy prompt instead."
                : "The assisted apply did not complete — try again or use Copy prompt instead."}
            </p>
            <div className="rec-actions-secondary">
              <button
                type="button"
                className="rec-action-btn rec-action-btn--primary"
                onClick={handleAssistedApply}
              >
                Retry
              </button>
              <button type="button" className="rec-action-btn" onClick={handleCopyPromptArtifact}>
                {artifactCopied ? "Copied ✓" : "Copy prompt"}
              </button>
            </div>
            <details className="rec-diagnostics">
              <summary>Developer diagnostics</summary>
              <div className="rec-diagnostics-body">
                <code>{applyState.message}</code>
              </div>
            </details>
          </div>
        )}
      </div>

      {/* Expanded details — methodology behind the toggle */}
      {expanded && (
        <div id={detailsId} className="rec-details">
          {grouped && (
            <h4 className="rec-section-label" hidden>
              Recommendation details
            </h4>
          )}
          {!grouped && (
            <div className="rec-section rec-rank-explanation">
              <h4 className="rec-section-label">Why this is ranked here</h4>
              <p>{rankExplanation(rec, rank, displayGroup)}</p>
            </div>
          )}

          <div className="rec-section">
            <h4 className="rec-section-label">What we observed</h4>
            <ul className="rec-observations">
              {visibleObservationFacts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>

          <div className="rec-section rec-modeled">
            <h4 className="rec-section-label">Expected impact</h4>
            {hasVisibleSavings && (
              <div className="rec-savings-value">
                {fmtUsd(rec.modeled_savings_u_per_wk as number)}/wk <Chip kind="MODELED" />
                <Chip kind="LIST_EQUIV" label="LIST_EQUIV · modeled USD" />
              </div>
            )}
            <p className="rec-modeled-note">{impactCaveat(rec)}</p>
            {assumptionNote !== null && <p className="rec-unvalidated-note">{assumptionNote}</p>}
          </div>

          {/* D1 backfire caveat: editing the cached prefix triggers a full cache-write next turn */}
          {isD1 && (
            <p className="rec-caveat-d1">
              Warning: batch this edit to a /clear or session boundary — editing the cached prefix
              forces one full-price cache WRITE next turn, momentarily increasing consumption.
            </p>
          )}

          {/* Lever / action */}
          <div className="rec-section">
            <h4 className="rec-section-label">Action</h4>
            <p className="rec-lever">{rec.lever}</p>
          </div>

          {/* Steps — numbered action list; steps key excluded from evidence table below */}
          {rec.steps.length > 0 && (
            <div className="rec-section">
              <h4 className="rec-section-label">Steps</h4>
              <ol className="rec-steps">
                {rec.steps.map((step, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: steps are ordered; content may repeat
                  <li key={i}>{stepDisplay(step)}</li>
                ))}
              </ol>
            </div>
          )}

          <div className="rec-section">
            <h4 className="rec-section-label">How to measure success</h4>
            <p className="rec-success-measure">{successMeasure(rec)}</p>
          </div>

          <details className="rec-diagnostics">
            <summary>Developer diagnostics</summary>
            <div className="rec-diagnostics-body">
              <div className="rec-section">
                <div className="rec-section-label">Provenance and scope</div>
                <ul className="rec-evidence">
                  <li>
                    <span className="rec-evidence-key">rec_id</span>: {rec.rec_id}
                  </li>
                  <li>
                    <span className="rec-evidence-key">detector</span>: {rec.detector_id} ·{" "}
                    {rec.category}
                  </li>
                  <li>
                    <span className="rec-evidence-key">state</span>: {rec.state}
                  </li>
                  <li>
                    <span className="rec-evidence-key">scope</span>:{" "}
                    {rec.scope_workspace_id ?? "global"}
                  </li>
                  <li>
                    <span className="rec-evidence-key">created_at</span>: {rec.created_at}
                  </li>
                  <li>
                    <span className="rec-evidence-key">run cost</span>:{" "}
                    {rec.run_cost_u === null ? "not yet recorded" : fmtUsd(rec.run_cost_u)}
                  </li>
                  {rec.file_ref !== null && (
                    <li>
                      <span className="rec-evidence-key">file_ref</span>: {fmtValue(rec.file_ref)}
                    </li>
                  )}
                </ul>
              </div>

              {diagnosticObservationFacts.length > 0 && (
                <div className="rec-section">
                  <div className="rec-section-label">Evidence details</div>
                  <ul className="rec-evidence rec-observed-evidence">
                    {diagnosticObservationFacts.map((fact) => (
                      <li key={fact}>{fact}</li>
                    ))}
                  </ul>
                </div>
              )}

              {causeFacets.length > 0 && (
                <div className="rec-section">
                  <div className="rec-section-label">Cause facets</div>
                  <ul className="rec-evidence">
                    {causeFacets.map((fact) => (
                      <li key={fact}>{fact}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="rec-section">
                <div className="rec-section-label">Raw detector evidence</div>
                <ul className="rec-evidence rec-evidence-raw">
                  {Object.entries(rec.evidence)
                    .filter(([key]) => key !== "steps" && key !== "title")
                    .map(([key, value]) => (
                      <li key={key}>
                        <span className="rec-evidence-key">{key}</span>: {fmtValue(value)}
                      </li>
                    ))}
                </ul>
              </div>

              <div className="rec-section">
                <div className="rec-section-label">Internal target metric</div>
                <code>{rec.target_metric}</code>
              </div>

              <div className="rec-section rec-formula-diagnostics">
                <div className="rec-section-label">Modeled formula</div>
                <p className="rec-formula-expr">
                  <code>{f.expression ?? f.kind ?? "No formula supplied"}</code>
                </p>
                <ul className="rec-formula-inputs">
                  {Object.entries(f.inputs).map(([key, value]) => (
                    <li key={key}>
                      <span className="rec-evidence-key">{key}</span>: {value.toLocaleString()}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </details>

          {/* Analyze with Claude — secondary action, in expanded section */}
          <div className="rec-actions-secondary">
            <button type="button" className="rec-action-btn" onClick={handleAnalyze}>
              Analyze with Claude
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function GroupedRecCard({
  group,
  rank,
  isFlagship,
  focusRecId = null,
  onDismissFocus,
  onDismiss,
  onAdopt,
}: {
  group: RecommendationGroup;
  rank: number;
  isFlagship?: boolean;
  focusRecId?: string | null;
  onDismissFocus?: () => void;
  onDismiss?: (recId: string) => void;
  onAdopt?: (recId: string) => void;
}) {
  const [artifactCopied, setArtifactCopied] = useState(false);
  const [guidedShown, setGuidedShown] = useState(false);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const promptArtifactId = useId();
  const snippetLabelId = useId();
  const focused = focusRecId !== null && group.recs.some((rec) => rec.rec_id === focusRecId);
  const cardRef = useRef<HTMLDivElement>(null);

  // Scroll the group card into view when it holds the deep-link target (RV6).
  useEffect(() => {
    if (focused) scrollFocusedIntoView(cardRef.current);
  }, [focused]);

  const representative = group.recs[0];
  if (representative === undefined) return null;

  const isMinorItems = group.detector_id === "MINOR_ITEMS";
  const promptArtifact = buildPromptArtifact(representative);
  const route = recRoute(representative.detector_id);
  const generatedSnippet: GeneratedSnippet | null =
    generateSettingsDisableBlock(representative) ??
    generateModelDefaultSnippet(representative) ??
    generateAutocompactSnippet(representative);
  // Secondary snippet offered alongside the primary (RI8): D4 subagent routing.
  const generatedSnippet2: GeneratedSnippet | null = generateSubagentRoutingSnippet(representative);
  const canDryRun = group.recs.some(canAssistedApplyForRec);
  const groupRankExplanation = isMinorItems
    ? "These recommendations are below the $1/week modeled-savings floor, so they stay together as minor items instead of taking separate top-level cards."
    : rankExplanation(representative, rank, group.label);
  const savingsSummary =
    group.total_savings_u_per_wk > 0
      ? `${fmtUsd(group.total_savings_u_per_wk)}/wk modeled across this group`
      : "No modeled savings; review the directional evidence below";

  function handleCopyPromptArtifact() {
    if (promptArtifact === null) return;
    void navigator.clipboard.writeText(promptArtifact.text).then(() => {
      setArtifactCopied(true);
      setTimeout(() => setArtifactCopied(false), 2000);
    });
  }

  function handleCopySnippet() {
    if (generatedSnippet === null) return;
    void navigator.clipboard.writeText(generatedSnippet.text).then(() => {
      setSnippetCopied(true);
      setTimeout(() => setSnippetCopied(false), 2000);
    });
  }

  const memberRows = group.recs.map((rec) => (
    <SingleRecCard
      key={rec.rec_id}
      rec={rec}
      grouped
      showSessionRows
      focusRecId={focusRecId}
      {...(onDismiss === undefined ? {} : { onDismiss })}
      {...(onAdopt === undefined ? {} : { onAdopt })}
    />
  ));

  return (
    <div
      ref={cardRef}
      className={`card rec-card rec-group-card${isMinorItems ? " rec-minor-items-card" : ""}${
        focused ? " rec-focus-highlight" : ""
      }`}
      data-detector-id={group.detector_id}
      style={{ marginBottom: 13 }}
    >
      {focused && (
        <FocusHighlightBanner
          {...(onDismissFocus === undefined ? {} : { onDismiss: onDismissFocus })}
        />
      )}
      {!isMinorItems && isFlagship && (
        <div className="rec-flagship-banner">
          <span className="rec-flagship-badge">HIGHEST-LEVERAGE</span>
          <span className="rec-flagship-rationale">
            Cache misses have ~10× the impact of memory trims.
          </span>
        </div>
      )}
      <div className="rec-group-header">
        <div className="rec-header-row">
          {!isMinorItems && <span className="rec-rank-badge">#{rank}</span>}
          <span className="rec-group-detector" title={group.detector_id}>
            {DETECTOR_GROUP_LABELS[group.detector_id] ?? group.label}
          </span>
          <h3 className="rec-title">{group.label}</h3>
          <span className="rec-group-count">
            {group.recs.length} recommendation{group.recs.length === 1 ? "" : "s"}
          </span>
          <ScopeBadge rec={representative} />
        </div>
        <div className="rec-group-summary">
          <span>
            {group.session_count} affected session{group.session_count === 1 ? "" : "s"}
          </span>
          <span>{savingsSummary}</span>
        </div>
        <div className="rec-section rec-rank-explanation">
          <h4 className="rec-section-label">Why this is ranked here</h4>
          <p>{groupRankExplanation}</p>
        </div>
        {!isMinorItems && route === "copy" && (
          <p className="rec-actions-hint">
            {canDryRun
              ? "Open in Claude Code (experimental) launches your terminal in the workspace with the prompt loaded — you review every edit."
              : "Applying is manual — copy the prompt and run it in your local Claude Code CLI."}
          </p>
        )}
        {!isMinorItems && route === "hook" && (
          <div className="rec-primary-action">
            <HookInstallButton />
            {promptArtifact !== null && (
              <div className="rec-guided-prompt">
                <button
                  type="button"
                  className="rec-action-btn rec-guided-toggle"
                  aria-expanded={guidedShown}
                  onClick={() => setGuidedShown((s) => !s)}
                >
                  {guidedShown ? "Hide guided prompt" : "Show guided prompt"}
                </button>
                {guidedShown && (
                  <div className="rec-prompt-artifact" data-flavor={promptArtifact.flavor}>
                    <label className="rec-section-label" htmlFor={promptArtifactId}>
                      Copy prompt
                    </label>
                    <textarea id={promptArtifactId} readOnly value={promptArtifact.text} />
                    <button
                      type="button"
                      className="rec-action-btn"
                      onClick={handleCopyPromptArtifact}
                    >
                      {artifactCopied ? "Copied ✓" : "Copy prompt"}
                    </button>
                    <span className="rec-prompt-scope-caption">
                      {scopePromptCaption(representative)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {!isMinorItems && route === "settings-idle" && (
          <div className="rec-primary-action">
            <a className="rec-action-btn rec-action-btn--primary" href="#/settings">
              Review idle sessions
            </a>
          </div>
        )}
        {!isMinorItems && route === "settings-calibrate" && (
          <div className="rec-primary-action">
            <a className="rec-action-btn rec-action-btn--primary" href="#/settings">
              Calibrate budget hook
            </a>
          </div>
        )}
        {!isMinorItems && route === "copy" && promptArtifact !== null && (
          <div className="rec-prompt-artifact" data-flavor={promptArtifact.flavor}>
            <label className="rec-section-label" htmlFor={promptArtifactId}>
              Copy prompt
            </label>
            <textarea id={promptArtifactId} readOnly value={promptArtifact.text} />
            <button
              type="button"
              className="rec-action-btn rec-action-btn--primary"
              onClick={handleCopyPromptArtifact}
            >
              {artifactCopied ? "Copied ✓" : "Copy prompt"}
            </button>
            <span className="rec-prompt-scope-caption">{scopePromptCaption(representative)}</span>
          </div>
        )}
        {!isMinorItems && generatedSnippet && (
          <div
            className="rec-prompt-artifact rec-generated-snippet"
            data-language={generatedSnippet.language}
          >
            <label className="rec-section-label" htmlFor={snippetLabelId}>
              {generatedSnippet.caption}
            </label>
            <textarea id={snippetLabelId} readOnly value={generatedSnippet.text} />
            <button type="button" className="rec-action-btn" onClick={handleCopySnippet}>
              {snippetCopied ? "Copied ✓" : "Copy snippet"}
            </button>
          </div>
        )}
        {!isMinorItems && generatedSnippet2 && <SnippetBlock snippet={generatedSnippet2} />}
        {group.detector_id === "D1" && (
          <p className="rec-d1-secondary-lever">
            This is the smallest lever — the one everyone blames. Cache misses (D8) have ~10× more
            impact on the same session.
          </p>
        )}
      </div>
      {isMinorItems ? (
        <details className="rec-minor-items" {...(focused ? { open: true } : {})}>
          <summary>
            Show {group.recs.length} minor item{group.recs.length === 1 ? "" : "s"}
          </summary>
          <div className="rec-group-members">{memberRows}</div>
        </details>
      ) : (
        <div className="rec-group-members">{memberRows}</div>
      )}
    </div>
  );
}

interface RecCardProps {
  rec?: RecommendationCard;
  group?: RecommendationGroup;
  /** Cross-list rank (1 = highest-leverage). Optional; defaults to 1 for standalone use. */
  rank?: number;
  /** True for the #1 ranked group — renders flagship badge + rationale. */
  isFlagship?: boolean;
  /** RV6 deep-link target: the rec_id to scroll to, highlight, and auto-expand. */
  focusRecId?: string | null;
  /** Called to clear the focus deep-link when the user dismisses the highlight. */
  onDismissFocus?: () => void;
  onDismiss?: (recId: string) => void;
  onAdopt?: (recId: string) => void;
}

export default function RecCard({
  rec,
  group,
  rank = 1,
  isFlagship,
  focusRecId = null,
  onDismissFocus,
  onDismiss,
  onAdopt,
}: RecCardProps) {
  if (group !== undefined) {
    return (
      <GroupedRecCard
        group={group}
        rank={rank}
        focusRecId={focusRecId}
        {...(isFlagship === undefined ? {} : { isFlagship })}
        {...(onDismissFocus === undefined ? {} : { onDismissFocus })}
        {...(onDismiss === undefined ? {} : { onDismiss })}
        {...(onAdopt === undefined ? {} : { onAdopt })}
      />
    );
  }
  if (rec === undefined) return null;
  return (
    <SingleRecCard
      rec={rec}
      rank={rank}
      focusRecId={focusRecId}
      {...(isFlagship === undefined ? {} : { isFlagship })}
      {...(onDismissFocus === undefined ? {} : { onDismissFocus })}
      {...(onDismiss === undefined ? {} : { onDismiss })}
      {...(onAdopt === undefined ? {} : { onAdopt })}
    />
  );
}
