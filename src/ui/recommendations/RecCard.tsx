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
import type { EffectEvidencePage } from "../../effects/api-contract";
import { buildSeededPrompt } from "../../query/api/rec-prompt"; // browser-safe; avoids pulling server-side graph
import type {
  BoundedStep,
  RecommendationCard,
  RecommendationGroup,
} from "../../query/api/recommendations";
import { fetchHookConfig, installHook } from "../api/client";
import {
  attestRollbackEffect,
  closeEffect,
  createEffectIdempotencyKey,
  fetchEffectEvidence,
  rollbackEffect,
  stopEffect,
  trackEffect,
} from "../api/effect-client";
import { useExperimentalActions } from "../hooks/useExperimentalActions";
import { workspaceLabel } from "../lib/workspace-label";
import Chip from "../shell/Chip";
import InfoTip from "../shell/InfoTip";
import EffectEvidence from "./EffectEvidence";
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

type PendingRecommendationAction = "adopt" | "dismiss" | "track" | null;
type CycleAction = "stop" | "close" | "rollback" | "attest-rollback";
type WriteAction = Exclude<PendingRecommendationAction, null> | CycleAction;

const ACTION_UNDO_WINDOW_MS = 5_000;

function EffectHistory({ recId }: { recId: string }) {
  const [state, setState] = useState<
    | { status: "loading"; cycles: never[]; legacy: never[]; nextCycle: null; nextLegacy: null }
    | {
        status: "ready" | "loading_more" | "error";
        cycles: EffectEvidencePage["cycles"];
        legacy: EffectEvidencePage["legacy"];
        nextCycle: string | null;
        nextLegacy: string | null;
        message?: string;
      }
  >({ status: "loading", cycles: [], legacy: [], nextCycle: null, nextLegacy: null });

  function load(more: boolean) {
    const previous = state;
    if (
      more &&
      (previous.status === "loading" ||
        (previous.nextCycle === null && previous.nextLegacy === null))
    )
      return;
    setState(
      more && previous.status !== "loading"
        ? (() => {
            const { message: _message, ...history } = previous;
            return { ...history, status: "loading_more" as const };
          })()
        : { status: "loading", cycles: [], legacy: [], nextCycle: null, nextLegacy: null },
    );
    void fetchEffectEvidence(
      recId,
      more && previous.status !== "loading"
        ? { cycle: previous.nextCycle, legacy: previous.nextLegacy }
        : {},
    )
      .then((page) => {
        const existingCycles = more && previous.status !== "loading" ? previous.cycles : [];
        const existingLegacy = more && previous.status !== "loading" ? previous.legacy : [];
        const cycles = [...existingCycles, ...page.cycles].filter(
          (item, index, items) =>
            items.findIndex((candidate) => candidate.cycleId === item.cycleId) === index,
        );
        const legacy = [...existingLegacy, ...page.legacy].filter(
          (item, index, items) =>
            items.findIndex((candidate) => candidate.cycleId === item.cycleId) === index,
        );
        setState({
          status: "ready",
          cycles,
          legacy,
          // A stream that was already exhausted must remain exhausted when the
          // other stream advances independently.
          nextCycle:
            more && previous.status !== "loading" && previous.nextCycle === null
              ? null
              : page.next_cycle_cursor,
          nextLegacy:
            more && previous.status !== "loading" && previous.nextLegacy === null
              ? null
              : page.next_legacy_cursor,
        });
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Could not load measurement history.";
        setState(
          more && previous.status !== "loading"
            ? { ...previous, status: "error", message }
            : {
                status: "error",
                cycles: [],
                legacy: [],
                nextCycle: null,
                nextLegacy: null,
                message,
              },
        );
      });
  }

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", cycles: [], legacy: [], nextCycle: null, nextLegacy: null });
    void fetchEffectEvidence(recId)
      .then((page) => {
        if (cancelled) return;
        setState({
          status: "ready",
          cycles: page.cycles,
          legacy: page.legacy,
          nextCycle: page.next_cycle_cursor,
          nextLegacy: page.next_legacy_cursor,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          cycles: [],
          legacy: [],
          nextCycle: null,
          nextLegacy: null,
          message: error instanceof Error ? error.message : "Could not load measurement history.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [recId]);

  const canLoadMore =
    state.status !== "loading" && (state.nextCycle !== null || state.nextLegacy !== null);
  return (
    <section className="rec-effect-history" aria-label="Measurement history">
      <h4>Measurement history</h4>
      {state.status === "loading" && <p aria-busy="true">Loading measurement history…</p>}
      {state.status === "error" && (
        <div role="alert">
          Could not load measurement history: {state.message}{" "}
          <button
            type="button"
            className="rec-action-btn"
            onClick={() => load(state.cycles.length > 0 || state.legacy.length > 0)}
          >
            Retry loading history
          </button>
        </div>
      )}
      {state.status !== "loading" && (state.cycles.length > 0 || state.legacy.length > 0) && (
        <ul>
          {state.cycles.map((item) => (
            <li key={item.cycleId}>
              <EffectEvidence cycle={item} />
            </li>
          ))}
          {state.legacy.map((item) => (
            <li key={item.cycleId}>
              Legacy target-metric result: {item.verdict ?? item.state.replaceAll("_", " ")} (
              {item.measuredAt.slice(0, 10)}) — read-only
            </li>
          ))}
        </ul>
      )}
      {state.status === "ready" && state.cycles.length === 0 && state.legacy.length === 0 && (
        <p>No recorded measurement history.</p>
      )}
      {(canLoadMore || state.status === "loading_more") && (
        <button
          type="button"
          className="rec-action-btn"
          onClick={() => load(true)}
          disabled={state.status === "loading_more"}
        >
          {state.status === "loading_more" ? "Loading…" : "Load more history"}
        </button>
      )}
    </section>
  );
}

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
  D2: "Long sessions",
  D4: "Model choice",
  D5: "Limit warning",
  D6: "Large tool results",
  D7: "Repeated attempts and reads",
  D8: "Cache misses",
  D9: "Background sessions",
  D10: "Tool catalog",
};

const CATEGORY_GROUP_FALLBACK: Record<string, string> = {
  CACHE: "Cache misses",
  CONTEXT: "Long sessions",
  LIMIT: "Limit warning",
  MODEL: "Model choice",
  SESSION_HYGIENE: "Background sessions",
  TOOLING: "Large tool results",
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
      tooltip: "Warning about how quickly your remaining allowance is being used",
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
      tooltip: "Possible pattern; savings have not been measured",
    };
  }
  if (rec.modeled_savings_u_per_wk !== null && rec.detector_id !== "D4") {
    return {
      label: "MODELED SAVINGS",
      className: "rec-confidence-tier--modeled",
      tooltip: "Possible savings calculated from assumptions that have not been verified",
    };
  }
  return {
    label: "DIRECTIONAL",
    className: "rec-confidence-tier--directional",
    tooltip: "Possible pattern; savings have not been measured",
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
  D8: "Cache misses can require the model to rewrite saved context",
  D2: "Long sessions send accumulated context with each request, so they are worth reviewing early",
  D4: "Changing models may help if your Opus or all-models limit fills first",
  D9: "Background work can be useful; check what the agents were doing before ending sessions",
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
          ? "Multiple long, high-context sessions crossed the threshold for long sessions."
          : `${count.toLocaleString()} long, high-context session${count === 1 ? "" : "s"} crossed the threshold for long sessions.`,
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
          ? "Some Opus turns matched the pattern of large input and short responses."
          : `${mismatch.toLocaleString()} of ${total.toLocaleString()} weekly Opus turns${fraction === null ? "" : ` (${fmtPercent(fraction)})`} matched the pattern of large input and short responses.`,
        "Session records cannot show which limit fills first. Check /usage in Claude Code before changing models.",
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
          : `Tool identified: ${attributedTool}.`,
        attributedBytes === null
          ? null
          : `Output size in bytes: ${attributedBytes.toLocaleString()}.`,
        carryTurns === null
          ? null
          : `Later turns carrying this output: ${carryTurns.toLocaleString()}.`,
        carryExposure === null
          ? null
          : `Estimated tokens carried into later turns: ${fmtTokens(carryExposure)} tokens.`,
      ].filter((fact): fact is string => fact !== null);
    }
    case "D7": {
      const coverage = evidenceNumber(rec, "owner_turn_metadata_coverage");
      const covered = evidenceNumber(rec, "owner_turn_metadata_covered_event_count");
      const denominator = evidenceNumber(rec, "owner_turn_metadata_denominator_event_count");
      return [
        "This detector crossed its configured threshold; raw measurements are available in developer diagnostics.",
        coverage === null
          ? null
          : `Tool events linked to a model response: ${fmtPercent(coverage)}.`,
        covered === null ? null : `Linked tool events: ${covered.toLocaleString()}.`,
        denominator === null
          ? null
          : `Total tool events checked: ${denominator.toLocaleString()} in-window events.`,
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
          ? "Parallel agents may be doing useful work; review their tasks before ending them."
          : "Links between a session and its background agents are inferred. Review their tasks before ending them.",
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
          : `The tool inventory scan estimated ${fmtTokens(catalog)} catalog tokens against a ${fmtTokens(target)} target${delta === null ? "." : `, or ${fmtTokens(delta)} tokens above target.`}`,
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
      return "Changing models may help if your all-models or Opus limit fills first. Check /usage in Claude Code before changing; no savings estimate is shown.";
    case "D6":
      return "Rough estimate: text size is converted at four bytes per token. Large output is not necessarily waste; check whether the task needed it.";
    case "D9":
      return "Background work may be useful. We cannot yet separate necessary parallel work from avoidable work, so no savings estimate is shown.";
    case "D7":
      return "Repeated attempts do not prove waste. Check whether each retry made progress; no savings estimate is shown.";
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
      return "Check again after 7 days: background agents should use fewer tokens while still completing useful work.";
    case "D1":
      return "After the next file scan, compare the size of instructions loaded in every session, then confirm average context per turn falls without lost guidance.";
    case "D10": {
      const catalog = evidenceNumber(rec, "catalog_tokens");
      const target = evidenceNumber(rec, "catalog_target_tokens");
      return `After the next tool inventory scan: the tool, plugin, and skill catalog estimate should move${catalog === null ? "" : ` from ${fmtTokens(catalog)}`}${target === null ? " below its target" : ` toward ${fmtTokens(target)}`} while required tools remain available.`;
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
      return "Start a fresh session with /clear between tasks";
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

// Share only an in-flight check across cards. Completed values are revalidated
// on remount, browser focus/visibility, and a successful settings mutation.
let hookCheck: Promise<boolean> | null = null;

function fetchHookInstalled(): Promise<boolean> {
  if (hookCheck !== null) return hookCheck;
  const pending = Promise.resolve()
    .then(() => fetchHookConfig())
    .then((res) => {
      if (res?.data === null || res?.data === undefined)
        throw new Error("Hook status unavailable.");
      return res.data.installed;
    });
  hookCheck = pending;
  const clear = () => {
    if (hookCheck === pending) hookCheck = null;
  };
  void pending.then(clear, clear);
  return pending;
}

/** Test-only: clear shared in-flight state between renders. */
export function __resetHookInstallCache(): void {
  hookCheck = null;
}

/** Primary action for behavioral (D2/D8/D7) cards: install the shipped hook. */
function HookInstallButton({ onInstalled }: { onInstalled?: () => void }) {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const revalidate = () => {
      hookCheck = null;
      setRefreshKey((key) => key + 1);
    };
    const visible = () => {
      if (!document.hidden) revalidate();
    };
    window.addEventListener("focus", revalidate);
    window.addEventListener("agentwrangler:hooks-changed", revalidate);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("agentwrangler:hooks-changed", revalidate);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey triggers status revalidation
  useEffect(() => {
    let active = true;
    setError(null);
    void fetchHookInstalled()
      .then((value) => {
        if (active) setInstalled(value);
      })
      .catch((e: unknown) => {
        if (active) {
          setInstalled(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      active = false;
    };
  }, [refreshKey]);

  async function onInstall() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await installHook();
      setInstalled(true);
      onInstalled?.();
    } catch (e: unknown) {
      setInstalled(false);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="rec-action-btn rec-action-btn--primary"
        onClick={() => (installed === null ? setRefreshKey((key) => key + 1) : void onInstall())}
        disabled={busy || installed === true || (installed === null && error === null)}
      >
        {busy
          ? "Installing…"
          : installed === true
            ? "Installed ✓"
            : installed === null
              ? error === null
                ? "Checking hook…"
                : "Retry status check"
              : "Install hook"}
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

async function fetchSessionToken(): Promise<string> {
  const res = await fetch("/api/token", { signal: AbortSignal.timeout(8_000) });
  if (res.ok) {
    const data = (await res.json()) as { token?: unknown };
    if (typeof data.token === "string" && data.token.length > 0) return data.token;
  }
  throw new Error("Unable to authorize this action. Check the daemon and retry.");
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
  onDismiss?: (recId: string) => void | Promise<void>;
  onAdopt?: (recId: string) => void | Promise<void>;
  onEffectMutated?: () => void;
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
  onEffectMutated,
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
  // Local evidence deliberately does not persist until the existing adopt endpoint is used.
  const [actionEvidence, setActionEvidence] = useState<"none" | "supported" | "manual">("none");
  const [manualAttested, setManualAttested] = useState(false);
  const capability = rec.effect_capability;
  const [cycle, setCycle] = useState(rec.effect_cycle ?? null);
  useEffect(() => {
    setCycle(rec.effect_cycle ?? null);
  }, [rec.effect_cycle]);
  const trackKey = useRef<string | null>(null);
  const lifecycleKeys = useRef(new Map<string, string>());
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [retrackConfirmation, setRetrackConfirmation] = useState(false);
  const [retrackAttested, setRetrackAttested] = useState(false);
  const [openTerminalMsg, setOpenTerminalMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [pendingAction, setPendingAction] = useState<PendingRecommendationAction>(null);
  const [pendingTimeoutId, setPendingTimeoutId] = useState<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const [writeState, setWriteState] = useState<
    | { status: "idle" | "saving" }
    | { status: "saved"; action: WriteAction }
    | { status: "failed"; action: WriteAction; message: string }
  >({ status: "idle" });
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
  const isAdopted =
    rec.state !== "PROPOSED" ||
    cycle !== null ||
    pendingAction === "adopt" ||
    pendingAction === "track";
  const terminalCycle =
    cycle !== null &&
    (cycle.state === "STOPPED" || cycle.state === "FINALIZED" || cycle.state === "UNSUPPORTED");
  const unsupportedCycle = cycle !== null && cycle.versionStatus !== "SUPPORTED";
  const canStartCycle = capability?.mode === "TRACKABLE" && !unsupportedCycle;
  const canMutateCycle =
    cycle !== null &&
    !unsupportedCycle &&
    (capability?.mode === "TRACKABLE" || capability?.mode === "MANUAL");
  const canRetrack = terminalCycle && canStartCycle && cycle?.rollbackStatus !== "PENDING";
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
      setActionEvidence("manual");
      setTimeout(() => setArtifactCopied(false), 2000);
    });
  }

  function handleCopySnippet() {
    if (generatedSnippet === null) return;
    void navigator.clipboard.writeText(generatedSnippet.text).then(() => {
      setSnippetCopied(true);
      setActionEvidence("manual");
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

  async function commitAction(action: "adopt" | "dismiss") {
    const commit = action === "adopt" ? onAdopt : onDismiss;
    if (commit === undefined || savingRef.current) return;
    savingRef.current = true;
    setWriteState({ status: "saving" });
    try {
      await commit(rec.rec_id);
      setWriteState({ status: "saved", action });
    } catch (error: unknown) {
      setWriteState({
        status: "failed",
        action,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      savingRef.current = false;
    }
  }

  async function commitTrack() {
    if (savingRef.current || !canStartCycle) return;
    savingRef.current = true;
    setWriteState({ status: "saving" });
    try {
      trackKey.current ??= createEffectIdempotencyKey(rec.rec_id, "track");
      const result = await trackEffect(rec.rec_id, trackKey.current);
      if (!result.supported || result.cycle === undefined) {
        throw new Error(result.reason ?? "Measurement is not supported for this change.");
      }
      setCycle(result.cycle);
      setHistoryRefreshKey((key) => key + 1);
      setWriteState({ status: "saved", action: "track" });
      onEffectMutated?.();
    } catch (error: unknown) {
      setWriteState({
        status: "failed",
        action: "track",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      savingRef.current = false;
    }
  }

  function scheduleAction(action: Exclude<PendingRecommendationAction, null>) {
    const commit = action === "adopt" ? onAdopt : action === "dismiss" ? onDismiss : undefined;
    if (
      (action !== "track" && commit === undefined) ||
      pendingTimeoutRef.current !== null ||
      savingRef.current
    )
      return;

    setWriteState({ status: "idle" });
    setPendingAction(action);
    const timeoutId = setTimeout(() => {
      pendingTimeoutRef.current = null;
      setPendingTimeoutId(null);
      setPendingAction(null);
      if (action === "track") void commitTrack();
      else void commitAction(action);
    }, ACTION_UNDO_WINDOW_MS);
    pendingTimeoutRef.current = timeoutId;
    setPendingTimeoutId(timeoutId);
  }

  function requestTrack() {
    if (terminalCycle) {
      if (!canRetrack) return;
      setRetrackAttested(false);
      setRetrackConfirmation(true);
      return;
    }
    scheduleAction("track");
  }

  function confirmRetrack() {
    if (!canRetrack || !retrackAttested || savingRef.current || pendingAction !== null) return;
    trackKey.current = null;
    setRetrackConfirmation(false);
    scheduleAction("track");
  }

  function lifecycleKey(action: CycleAction, cycleId: string): string {
    const intent = `${action}:${cycleId}`;
    const existing = lifecycleKeys.current.get(intent);
    if (existing !== undefined) return existing;
    const created = createEffectIdempotencyKey(rec.rec_id, intent);
    lifecycleKeys.current.set(intent, created);
    return created;
  }

  async function runCycleAction(action: CycleAction) {
    if (cycle === null || !canMutateCycle || savingRef.current || pendingAction !== null) return;
    const currentCycle = cycle;
    savingRef.current = true;
    setWriteState({ status: "saving" });
    try {
      const key = lifecycleKey(action, currentCycle.cycleId);
      if (action === "stop" || action === "close") {
        const result = await (action === "stop" ? stopEffect : closeEffect)(
          currentCycle.cycleId,
          key,
        );
        setCycle(result);
      } else {
        const operation = await (action === "rollback" ? rollbackEffect : attestRollbackEffect)(
          currentCycle.cycleId,
          key,
        );
        // Rollback responses describe an operation; re-read its cycle so terminal
        // state, comparison evidence and attribution boundaries remain authoritative.
        const page = await fetchEffectEvidence(rec.rec_id);
        const updated = page.cycles.find((item) => item.cycleId === operation.cycleId);
        if (updated === undefined)
          throw new Error(
            "Change recorded, but its measurement could not be refreshed. Retry to reload it.",
          );
        setCycle(updated);
      }
      setHistoryRefreshKey((key) => key + 1);
      setWriteState({ status: "saved", action });
      onEffectMutated?.();
    } catch (error: unknown) {
      setWriteState({
        status: "failed",
        action,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      savingRef.current = false;
    }
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
        setActionEvidence("supported");
        return;
      }
      if (job.status === "ROLLED_BACK") {
        setApplyState({ status: "rolled_back" });
        setActionEvidence("none");
        setManualAttested(false);
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
          setActionEvidence("manual");
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
        setActionEvidence("none");
        setManualAttested(false);
      })
      .catch((e: unknown) => {
        setApplyState({ status: "failed", message: e instanceof Error ? e.message : String(e) });
      });
  }

  function requestManualRollback() {
    void runCycleAction("rollback");
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
          <span className="rec-flagship-badge">CHECK FIRST</span>
          <span className="rec-flagship-rationale">
            Reusing saved context can reduce repeated token use.
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
                {pendingAction === "adopt" ? "Adopt pending — Undo" : "Adopted"}
              </span>
            )}
            {pendingAction === "dismiss" && (
              <span className="rec-pending-action-pill">Dismiss pending — Undo</span>
            )}
          </div>
          <div className="rec-headline">
            <span className="rec-headline-text">{headlineText}</span>
            <span className="rec-chip-row" aria-label="Recommendation claim indicators">
              <InfoTip
                label="What the claim chips mean"
                content="These labels distinguish recorded measurements from estimates. A recorded measurement does not prove that a suggestion will save tokens."
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
              Review the measured file size before editing. Keep instructions the project still
              needs.
            </p>
          )}
        </div>
        <div className="rec-actions">
          <button
            type="button"
            className="rec-action-btn rec-action-btn--ghost"
            onClick={() => scheduleAction("dismiss")}
            disabled={!onDismiss || pendingAction !== null || writeState.status === "saving"}
          >
            Dismiss
          </button>
          {(rec.detector_id === "D5" ||
            (capability?.mode === "TRACKABLE" &&
              !unsupportedCycle &&
              ((cycle === null &&
                actionEvidence !== "none" &&
                (actionEvidence === "supported" || manualAttested)) ||
                canRetrack))) && (
            <button
              type="button"
              className="rec-action-btn"
              title={
                rec.detector_id === "D5"
                  ? "Records the calibration warning as acknowledged without impact tracking."
                  : "Records a baseline for this completed change; it changes no files."
              }
              onClick={() => (rec.detector_id === "D5" ? scheduleAction("adopt") : requestTrack())}
              disabled={
                (rec.detector_id === "D5" && !onAdopt) ||
                pendingAction !== null ||
                writeState.status === "saving"
              }
            >
              {rec.detector_id === "D5"
                ? "Acknowledge"
                : terminalCycle
                  ? "Track another change"
                  : "Track this change"}
            </button>
          )}
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
            <HookInstallButton onInstalled={() => setActionEvidence("supported")} />
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
            <a
              className="rec-action-btn rec-action-btn--primary"
              href="#/settings?section=idle-sessions"
            >
              Review idle sessions
            </a>
          </div>
        )}
        {!grouped && route === "settings-calibrate" && (
          <div className="rec-primary-action">
            <a
              className="rec-action-btn rec-action-btn--primary"
              href="#/settings?section=calibration"
            >
              Calibrate budget hook
            </a>
          </div>
        )}
        {(!grouped || expanded) && route === "copy" && promptArtifact !== null && (
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
        {rec.detector_id !== "D5" && actionEvidence === "manual" && !manualAttested && (
          <div className="rec-tracking-gate">
            <p>
              A copied prompt or launched terminal is not proof of a change. Confirm only after you
              completed it and it remains applied for the measurement window.
            </p>
            <button
              type="button"
              className="rec-action-btn"
              onClick={() => setManualAttested(true)}
            >
              I completed the change
            </button>
          </div>
        )}
        {rec.detector_id !== "D5" &&
          capability !== undefined &&
          capability.mode !== "TRACKABLE" && (
            <p className="rec-tracking-gate">
              {capability.mode === "READ_ONLY"
                ? "This recommendation is read-only; measurement cannot be started."
                : capability.mode === "MANUAL"
                  ? "Measurement is manual for this recommendation; no countdown or result is being recorded."
                  : "This recommendation is acknowledged without impact measurement."}
              {capability.reason ? ` ${capability.reason}` : ""}
            </p>
          )}
        {rec.detector_id !== "D5" && capability === undefined && (
          <p className="rec-tracking-gate">
            Measurement availability is unknown for this older recommendation. It remains manual and
            no countdown is shown.
          </p>
        )}
        {rec.detector_id !== "D5" &&
          actionEvidence !== "none" &&
          (actionEvidence === "supported" || manualAttested) &&
          !isAdopted && (
            <p className="rec-tracking-gate">
              Tracking records a baseline; it does not prove effectiveness. You can stop measurement
              later without changing your file.
            </p>
          )}
        {cycle !== null && (
          <div className="rec-tracking-gate">
            <EffectEvidence cycle={cycle} />
            {!canMutateCycle ? (
              <p>This measurement is read-only; lifecycle controls are unavailable.</p>
            ) : (
              <div className="rec-actions-secondary">
                {(cycle.state === "OPEN_SETTLING" || cycle.state === "OPEN_MEASURING") && (
                  <button
                    type="button"
                    className="rec-action-btn"
                    onClick={() => void runCycleAction("stop")}
                    disabled={writeState.status === "saving" || pendingAction !== null}
                  >
                    Stop measurement
                  </button>
                )}
                {cycle.state === "FINALIZED" && cycle.attributionClosedAt === null && (
                  <button
                    type="button"
                    className="rec-action-btn"
                    onClick={() => void runCycleAction("close")}
                    disabled={writeState.status === "saving" || pendingAction !== null}
                  >
                    Close attribution
                  </button>
                )}
              </div>
            )}
            {canMutateCycle &&
              cycle.rollbackStatus !== "PENDING" &&
              cycle.rollbackStatus !== "SUCCEEDED" &&
              cycle.rollbackStatus !== "USER_ATTESTED" && (
                <div>
                  <p>
                    To undo the file change, revert it manually. Stopping measurement alone does not
                    revert files.
                  </p>
                  <button
                    type="button"
                    className="rec-action-btn"
                    disabled={writeState.status === "saving" || pendingAction !== null}
                    onClick={() => void runCycleAction("attest-rollback")}
                  >
                    I reverted the change
                  </button>
                </div>
              )}
            <EffectHistory key={`${rec.rec_id}:${historyRefreshKey}`} recId={rec.rec_id} />
          </div>
        )}
        {retrackConfirmation && (
          <div className="rec-tracking-gate">
            <p>This starts a new measurement cycle. Earlier cycles stay in the history above.</p>
            <label>
              <input
                type="checkbox"
                checked={retrackAttested}
                onChange={(event) => setRetrackAttested(event.target.checked)}
              />
              I completed another change and want to measure it.
            </label>
            <button
              type="button"
              className="rec-action-btn"
              onClick={confirmRetrack}
              disabled={!retrackAttested || !canRetrack || writeState.status === "saving"}
            >
              Confirm retrack
            </button>
            <button
              type="button"
              className="rec-action-btn"
              onClick={() => setRetrackConfirmation(false)}
            >
              Cancel retrack
            </button>
          </div>
        )}
        {!grouped && route === "copy" && (
          <p className="rec-actions-hint">
            {experimental && canOpenTerminal
              ? "Open in Claude Code launches your terminal in this workspace with the prompt loaded — you review and drive every edit."
              : "Copy the prompt into Claude Code in this workspace, then review the proposed changes."}
          </p>
        )}
        {pendingAction !== null && pendingTimeoutId !== null && (
          <output className="rec-action-toast">
            <span>
              {pendingAction === "adopt"
                ? "Adopt pending — Undo"
                : pendingAction === "track"
                  ? "Track pending — Undo"
                  : "Dismiss pending — Undo"}
            </span>
            <button type="button" className="rec-action-toast-undo" onClick={clearPendingAction}>
              Undo
            </button>
          </output>
        )}
        {writeState.status === "saving" && <output>Saving change…</output>}
        {writeState.status === "saved" && (
          <output>
            {writeState.action === "adopt"
              ? rec.detector_id === "D5"
                ? "Acknowledgment saved"
                : "Tracking saved"
              : writeState.action === "track"
                ? "Tracking saved"
                : writeState.action === "stop"
                  ? cycle?.state === "STOPPED"
                    ? "Measurement stopped"
                    : "Measurement refreshed"
                  : writeState.action === "close"
                    ? "Attribution closed"
                    : writeState.action === "rollback"
                      ? "Manual rollback request recorded; no files changed"
                      : writeState.action === "attest-rollback"
                        ? "Rollback attestation recorded; actual rollback time is unknown"
                        : "Dismissal saved"}
          </output>
        )}
        {writeState.status === "failed" && (
          <div className="rec-apply-status rec-apply-status--error" role="alert">
            Could not save: {writeState.message}{" "}
            <button
              type="button"
              className="rec-action-btn"
              onClick={() =>
                writeState.action === "track"
                  ? void commitTrack()
                  : writeState.action === "adopt" || writeState.action === "dismiss"
                    ? void commitAction(writeState.action)
                    : void runCycleAction(writeState.action)
              }
            >
              Retry
            </button>
          </div>
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
            {capability === undefined && cycle === null ? (
              <div className="rec-actions-secondary">
                <button type="button" className="rec-action-btn" onClick={handleRollbackApply}>
                  Roll back
                </button>
              </div>
            ) : (
              <div className="rec-tracking-gate">
                <p>
                  This versioned recommendation has no safe whole-file rollback. Revert the change
                  manually; that does not erase its measurement history.
                </p>
                {cycle === null ? (
                  <p>
                    Start tracking the completed change before recording a rollback attestation.
                  </p>
                ) : cycle.rollbackStatus === "MANUAL" || cycle.rollbackStatus === "UNSUPPORTED" ? (
                  <p>After reverting the file, use “I reverted the change” above.</p>
                ) : (
                  <button
                    type="button"
                    className="rec-action-btn"
                    disabled={!canMutateCycle || writeState.status === "saving"}
                    onClick={requestManualRollback}
                  >
                    Revert manually
                  </button>
                )}
              </div>
            )}
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
            {promptArtifact !== null && (
              <textarea
                className="prompt-code"
                aria-label="Retry prompt"
                readOnly
                value={promptArtifact.text}
              />
            )}
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
            <h4 className="rec-section-label">
              What we observed{" "}
              <InfoTip
                label="Understanding these measurements"
                content="Context is the text sent to the model with a request. Cache reads reuse saved text; cache writes save it again. Cap-weighted tokens estimate allowance use using different weights for these operations; they do not report your actual remaining limit. A turn is one model response."
              />
            </h4>
            <ul className="rec-observations">
              {visibleObservationFacts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>

          <div className="rec-section rec-modeled">
            <h4 className="rec-section-label">Possible reduction</h4>
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
              Make this edit between tasks or after /clear. Changing instructions already in the
              session can increase token use on the next message because saved context must be
              rewritten.
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
  onEffectMutated,
}: {
  group: RecommendationGroup;
  rank: number;
  isFlagship?: boolean;
  focusRecId?: string | null;
  onDismissFocus?: () => void;
  onDismiss?: (recId: string) => void | Promise<void>;
  onAdopt?: (recId: string) => void | Promise<void>;
  onEffectMutated?: () => void;
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
      {...(onEffectMutated === undefined ? {} : { onEffectMutated })}
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
          <span className="rec-flagship-badge">CHECK FIRST</span>
          <span className="rec-flagship-rationale">
            Reusing saved context can reduce repeated token use.
          </span>
        </div>
      )}
      <div className="rec-group-header">
        <div className="rec-header-row">
          {!isMinorItems && <span className="rec-rank-badge">#{rank}</span>}
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
              : "Copy the prompt into Claude Code in this workspace, then review the proposed changes."}
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
            <a
              className="rec-action-btn rec-action-btn--primary"
              href="#/settings?section=idle-sessions"
            >
              Review idle sessions
            </a>
          </div>
        )}
        {!isMinorItems && route === "settings-calibrate" && (
          <div className="rec-primary-action">
            <a
              className="rec-action-btn rec-action-btn--primary"
              href="#/settings?section=calibration"
            >
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
            <p className="rec-actions-hint">
              This previews the first recommendation. To track a change, expand that
              recommendation's details, copy its prompt, complete the change, then confirm it there.
            </p>
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
            Review the measured file size before editing. Keep instructions the project still needs.
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
  onDismiss?: (recId: string) => void | Promise<void>;
  onAdopt?: (recId: string) => void | Promise<void>;
  onEffectMutated?: () => void;
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
  onEffectMutated,
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
        {...(onEffectMutated === undefined ? {} : { onEffectMutated })}
      />
    );
  }
  if (rec === undefined) return null;
  return (
    <SingleRecCard
      rec={rec}
      rank={rank}
      showSessionRows
      focusRecId={focusRecId}
      {...(isFlagship === undefined ? {} : { isFlagship })}
      {...(onDismissFocus === undefined ? {} : { onDismissFocus })}
      {...(onDismiss === undefined ? {} : { onDismiss })}
      {...(onAdopt === undefined ? {} : { onAdopt })}
      {...(onEffectMutated === undefined ? {} : { onEffectMutated })}
    />
  );
}
